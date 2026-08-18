import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CapturedWebhook, PAYMENT_PROVIDER, PaymentProvider } from '../../adapters/payments/payment.provider';
import { NOTIFICATION_PROVIDER, NotificationProvider } from '../../adapters/notifications/notification.provider';
import { InvoicingService } from '../invoicing/invoicing.service';
import { PushService } from '../devices/push.service';

@Injectable()
export class PaymentsService {
  private readonly log = new Logger('PaymentsNotify');
  private static readonly GRACE_DAYS = 2;

  constructor(
    private prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private provider: PaymentProvider,
    private invoicing: InvoicingService,
    @Inject(NOTIFICATION_PROVIDER) private notifier: NotificationProvider,
    private push: PushService,
  ) {}

  async handleCaptured(subscriptionId: string, event: CapturedWebhook, signature: string) {
    if (!this.provider.verifySignature(event, signature)) throw new BadRequestException('Invalid signature');
    return this.applyCaptured(subscriptionId, event);
  }

  // Records the captured payment, activates the subscription and generates the
  // GST invoice. Idempotent on (provider, webhook_event_id). The caller must
  // have verified authenticity first — the Razorpay webhook route verifies the
  // raw-body HMAC before calling this directly.
  async applyCaptured(subscriptionId: string, event: CapturedWebhook) {
    const existing = await this.prisma.payments.findUnique({
      where: { provider_webhook_event_id: { provider: 'razorpay', webhook_event_id: event.eventId } } as any,
    });
    if (existing) return { idempotent: true };
    let payment;
    try {
      payment = await this.prisma.payments.create({
        data: {
          subscription_id: subscriptionId,
          provider: 'razorpay',
          provider_payment_id: event.providerSubscriptionId,
          amount_inr: event.amountInr,
          status: 'captured',
          webhook_event_id: event.eventId,
          paid_at: new Date(),
        },
      });
    } catch (e: any) {
      // Unique (provider, webhook_event_id) hit: a concurrent delivery of the
      // same webhook won the race — treat this one as the idempotent replay.
      if (e?.code === 'P2002') return { idempotent: true };
      throw e;
    }
    await this.prisma.subscriptions.update({
      where: { id: subscriptionId },
      data: { status: 'active', payment_failed_at: null, payment_grace_until: null },
    });
    // Q&A Addendum E: generate a GST invoice for the captured payment.
    await this.invoicing.generateForPayment({ id: payment.id, subscription_id: subscriptionId, amount_inr: event.amountInr });
    // Best-effort customer notification — never fail the capture if it errors.
    try {
      const sub = await this.prisma.subscriptions.findUnique({
        where: { id: subscriptionId },
        select: { customer: { select: { user: { select: { id: true, phone: true } } } } },
      });
      const user = (sub as any)?.customer?.user;
      if (user?.phone) await this.notifier.send(user.phone, 'payment_captured', { amountInr: event.amountInr });
      if (user?.id) {
        await this.push.notifyUser(user.id, {
          title: 'Payment received',
          body: `We've received ₹${event.amountInr}. Your plan is active.`,
          data: { type: 'payment_captured' },
        });
      }
    } catch (e) {
      this.log.warn(`payment_captured notification failed: ${e}`);
    }
    return { idempotent: false };
  }

  // Razorpay subscription.authenticated webhook (production backstop for the
  // app's confirm call): flip a pending subscription to trialing/active once the
  // mandate is authorized. No-op if already activated or not found.
  async activateAuthenticated(razorpaySubscriptionId: string) {
    const sub = await this.prisma.subscriptions.findFirst({
      where: { razorpay_subscription_id: razorpaySubscriptionId, status: 'pending' },
    });
    if (!sub) return { updated: false };
    const isTrial = !!sub.trial_end_date && sub.trial_end_date.getTime() > Date.now();
    await this.prisma.subscriptions.update({ where: { id: sub.id }, data: { status: isTrial ? 'trialing' : 'active' } });
    return { updated: true };
  }

  // Mirror the gateway's next-charge date onto the subscription. `undefined`
  // means the caller had nothing to report (so leave whatever we had); `null`
  // genuinely means "no next charge", which is what a paused mandate looks like.
  async rememberChargeAt(subscriptionId: string, chargeAt: Date | null | undefined): Promise<void> {
    if (chargeAt === undefined) return;
    try {
      await this.prisma.subscriptions.update({ where: { id: subscriptionId }, data: { next_charge_at: chargeAt } });
    } catch (e) {
      // Display-only data — never let it break a payment or a pause.
      this.log.warn(`could not store next_charge_at for ${subscriptionId}: ${e}`);
    }
  }

  // Gateway statuses that mean "the customer authorized this mandate and billing
  // is healthy". `pending`/`halted` also imply authorization but with a FAILING
  // charge, so they are surfaced for a human instead of being auto-activated —
  // activating them would hand out service we are not being paid for.
  private static readonly AUTHORIZED_MANDATE_STATUSES = ['authenticated', 'active'];
  private static readonly FAILING_MANDATE_STATUSES = ['pending', 'halted'];

  // Ask the gateway what really happened to a `pending` subscription's mandate
  // and heal our row from the answer.
  //
  // A subscription only leaves `pending` when the app's confirm call or the
  // subscription.authenticated webhook says so. If the customer authorizes the
  // sheet but dismisses it before the SDK callback fires — and the webhook is
  // missing or undelivered — the money side is live while our side is dead, and
  // nothing ever recovers it. This is that recovery: the gateway is the source
  // of truth, and it is queried on demand (subscribe screen, hub button, repair
  // script) rather than on a cron.
  //
  // Deliberately never writes a `payments` row: captured payments (and the GST
  // invoices derived from them) come only from applyCaptured via the
  // subscription.charged webhook, so invoicing stays single-sourced.
  async reconcilePending(subscriptionId: string): Promise<{
    action: 'activated' | 'abandoned' | 'needs_attention' | 'unchanged' | 'error';
    gatewayStatus?: string;
  }> {
    const sub = await this.prisma.subscriptions.findUnique({
      where: { id: subscriptionId },
      select: { status: true, razorpay_subscription_id: true },
    });
    if (!sub || sub.status !== 'pending' || !sub.razorpay_subscription_id) return { action: 'unchanged' };

    let gatewayStatus: string;
    let chargeAt: Date | null | undefined;
    try {
      ({ status: gatewayStatus, chargeAt } = await this.provider.fetchMandate(sub.razorpay_subscription_id));
    } catch (e) {
      // A gateway outage must never break the caller (the subscribe screen is
      // the main one) — report it and leave the row untouched.
      this.log.warn(`reconcilePending(${subscriptionId}) could not reach the gateway: ${e}`);
      return { action: 'error' };
    }

    if (PaymentsService.AUTHORIZED_MANDATE_STATUSES.includes(gatewayStatus)) {
      // Reuse the webhook's own activation path so trialing-vs-active is decided
      // in exactly one place.
      const { updated } = await this.activateAuthenticated(sub.razorpay_subscription_id);
      // We just asked the gateway anyway — record its real next-charge date while
      // we have it, so the app and hub stop showing our drifting end_date.
      await this.rememberChargeAt(subscriptionId, chargeAt);
      return { action: updated ? 'activated' : 'unchanged', gatewayStatus };
    }
    if (PaymentsService.FAILING_MANDATE_STATUSES.includes(gatewayStatus)) {
      this.log.warn(`Subscription ${subscriptionId} has an authorized mandate whose billing is ${gatewayStatus} — needs a human.`);
      return { action: 'needs_attention', gatewayStatus };
    }
    // created / cancelled / expired / completed: a genuinely abandoned checkout.
    // Leave it `pending` so the car reads as unsubscribed, which is the truth.
    return { action: 'abandoned', gatewayStatus };
  }

  // Autopay failed. Keep serving for GRACE_DAYS, then the serviceability predicate
  // stops washes automatically (no cron). A later successful charge recovers it.
  private static readonly FAILABLE_STATUSES = ['active', 'trialing', 'paused'];

  async markPaymentFailed(subscriptionId: string, now: Date = new Date()) {
    // Guard against a late/stray subscription.halted or payment.failed webhook
    // resurrecting a cancelled/terminated sub: only a live sub can enter the
    // payment_failed grace window. Fetch status + phone in one round-trip.
    const sub = await this.prisma.subscriptions.findUnique({
      where: { id: subscriptionId },
      select: { status: true, customer: { select: { user: { select: { id: true, phone: true } } } } },
    });
    if (!sub || !PaymentsService.FAILABLE_STATUSES.includes((sub as any).status)) {
      return { ignored: true };
    }
    const graceUntil = new Date(now);
    graceUntil.setUTCDate(graceUntil.getUTCDate() + PaymentsService.GRACE_DAYS);
    await this.prisma.subscriptions.update({
      where: { id: subscriptionId },
      data: { status: 'payment_failed', payment_failed_at: now, payment_grace_until: graceUntil },
    });
    try {
      const user = (sub as any)?.customer?.user;
      if (user?.phone) await this.notifier.send(user.phone, 'payment_failed', { graceUntil: graceUntil.toISOString() });
      if (user?.id) {
        await this.push.notifyUser(user.id, {
          title: 'Payment failed',
          body: "We couldn't collect your subscription payment. Tap to fix it before service pauses.",
          data: { type: 'payment_failed' },
        });
      }
    } catch (e) {
      this.log.warn(`payment_failed notification failed: ${e}`);
    }
    return { failed: true, graceUntil };
  }
}
