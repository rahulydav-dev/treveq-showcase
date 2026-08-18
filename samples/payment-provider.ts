import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import Razorpay = require('razorpay');
import { PLAN_TIER_PRICES } from '../../domain/pricing';
import {
  CapturedWebhook,
  CreateMandateInput,
  MandateResult,
  MandateStatus,
  PaymentProvider,
} from './payment.provider';

@Injectable()
export class RazorpayPaymentProvider implements PaymentProvider {
  private readonly client: Razorpay;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly planMap: Record<string, string>;

  constructor(config: ConfigService) {
    this.keySecret = config.getOrThrow('RAZORPAY_KEY_SECRET');
    this.client = new Razorpay({
      key_id: config.getOrThrow('RAZORPAY_KEY_ID'),
      key_secret: this.keySecret,
    });
    this.webhookSecret = config.getOrThrow('RAZORPAY_WEBHOOK_SECRET');
    this.planMap = JSON.parse(config.get<string>('RAZORPAY_PLAN_MAP') ?? '{}');

    const isProd = (config.get<string>('NODE_ENV') ?? '') === 'production';

    // getOrThrow only rejects undefined — a blank `RAZORPAY_WEBHOOK_SECRET=`
    // line yields '' and would make every webhook HMAC verifiable by anyone
    // (forged subscription.charged → free activations). Fail closed in prod.
    if (!this.webhookSecret) {
      const msg = 'RAZORPAY_WEBHOOK_SECRET is empty — webhook signatures would be forgeable. Set it from the Razorpay dashboard webhook config.';
      if (isProd) throw new Error(msg);
      // eslint-disable-next-line no-console
      console.warn(`[payments] ${msg}`);
    }

    // Fail fast (in prod) when the plan map doesn't cover the live tier prices:
    // a missing entry otherwise surfaces only at the first subscribe attempt as
    // "No Razorpay plan mapped for amount ₹899". Mirrors resolveJwtSecret().
    const tierPrices = [...new Set(Object.values(PLAN_TIER_PRICES))];
    const missing = tierPrices.filter((p) => !this.planMap[String(p)]);
    if (missing.length) {
      const msg =
        `RAZORPAY_PLAN_MAP is missing Razorpay plan id(s) for amount(s): ₹${missing.join(', ₹')}. ` +
        `Create plans for the live tiers (${tierPrices.map((p) => `₹${p}`).join(' / ')}) in the Razorpay dashboard ` +
        `and map them, e.g. {"899":"plan_xxx","999":"plan_yyy"}.`;
      if (isProd) throw new Error(msg);
      // eslint-disable-next-line no-console
      console.warn(`[payments] ${msg}`);
    }
  }

  async createMandate(input: CreateMandateInput): Promise<MandateResult> {
    // Plan is the recurring base price — always mapped.
    const planId = this.planMap[String(input.amountInr)];
    if (!planId) throw new Error(`No Razorpay plan mapped for amount ₹${input.amountInr}`);

    const params: Record<string, any> = {
      plan_id: planId,
      total_count: 12, // 12 billing cycles; renews thereafter
      customer_notify: 1,
      notes: { internalSubscriptionId: input.subscriptionId, method: input.method },
    };

    // Delay the first billing (Unix seconds) to the trial end. Without it,
    // Razorpay bills immediately after the mandate is authorized.
    if (input.billingStartsAt) {
      params.start_at = Math.floor(input.billingStartsAt.getTime() / 1000);
    }

    const sub = await this.client.subscriptions.create(params as any);
    return { providerSubscriptionId: sub.id };
  }

  async fetchMandate(providerSubscriptionId: string): Promise<MandateStatus> {
    const sub = await this.client.subscriptions.fetch(providerSubscriptionId);
    return { status: String((sub as any).status), chargeAt: chargeAtOf(sub) };
  }

  async cancelMandate(providerSubscriptionId: string): Promise<void> {
    // `false` → cancel immediately (not at cycle end); no further autopay is attempted.
    await this.client.subscriptions.cancel(providerSubscriptionId, false as any);
  }

  canReviveMandate(): boolean {
    // A cancelled Razorpay subscription cannot be resurrected, and a NEW one is
    // inert until the customer authorizes it in the checkout sheet — so a
    // server-side "revive" would create a mandate that never charges.
    return false;
  }

  verifySignature(event: CapturedWebhook, signature: string): boolean {
    const expected = createHmac('sha256', this.webhookSecret).update(JSON.stringify(event)).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // Razorpay subscription-payment signature: HMAC-SHA256(payment_id + '|' + subscription_id, key_secret).
  verifySubscriptionPayment(razorpaySubscriptionId: string, paymentId: string, signature: string): boolean {
    const expected = createHmac('sha256', this.keySecret).update(`${paymentId}|${razorpaySubscriptionId}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature ?? '');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

// Razorpay reports `charge_at` as Unix SECONDS, and as null once a subscription
// is paused. Exported so the webhook route reads it the same way — the event
// payloads carry the identical subscription entity.
export function chargeAtOf(entity: any): Date | null {
  const secs = entity?.charge_at;
  return typeof secs === 'number' && secs > 0 ? new Date(secs * 1000) : null;
}

// The Razorpay SDK rejects with a plain { statusCode, error } object and NO
// `message` — and on a 404 `error` is undefined — so both `e.message` and
// String(e) degrade to "undefined"/"[object Object]" in the logs, exactly when
// we need to know whether a pause failed on bad keys or a bad subscription id.
function describeGatewayError(e: any): string {
  if (!e) return 'unknown error';
  if (e.message) return e.message;
  const status = e.statusCode ? `HTTP ${e.statusCode}` : '';
  const detail = e.error ? `${e.error.code ?? ''} ${e.error.description ?? ''}`.trim() : '';
  return [status, detail].filter(Boolean).join(' — ') || JSON.stringify(e);
}
