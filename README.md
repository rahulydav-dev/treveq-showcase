# Treveq

A daily car-wash subscription service running in Gurgaon high-rise societies.
Customers subscribe once, set the time their car is free, and get a verified
exterior clean with before/after photo proof before they leave each morning.

Live with paying subscribers. This repository is a technical overview - the
production code is private.

---

## What it is

Six components, built and operated by one developer.

| Component | Stack | Responsibility |
|---|---|---|
| Backend API | NestJS, Prisma, PostgreSQL | Auth, subscriptions, billing, wash execution, ratings, referrals |
| Customer app | Flutter | Subscribe, track today's wash, view photo proof, rate, refer |
| Washer app | Flutter | Check-in, daily route, wash completion, earnings |
| Hub console | Vite, React | Daily operations for a single hub office |
| Support console | Vite, React | Subscriber lookup, call logging, issue resolution |
| CEO dashboard | Vite, React | Super-admin view across all hubs |

Deployed with Docker. iOS builds ship through Codemagic CI.

---

## Architecture

```
   Customer app          Washer app
   (Flutter)             (Flutter)
        \                    /
         v                  v
      +--------------------------+        +--------------+
      |   NestJS API             |<------>|  Payment     |
      |   auth, subscriptions    | webhook|  gateway     |
      |   billing, execution     |        +--------------+
      +--------------------------+
                  |
          +-------+--------+
          v                v
     PostgreSQL      Web dashboards
     (Prisma)        Hub, Support, CEO
```

One API serves all six clients. Subscription state has a single writer - the
payment webhook handler - so billing status never diverges between the mobile
app, the dashboards, and the database.

---

## Three problems worth explaining

### Recurring billing on payment mandates

Customers authorize a mandate once at signup and are charged automatically each
cycle. The system handles mandate creation, webhook signature verification,
charge confirmation, failed-payment retries, mandate cancellation, and plan
changes.

Webhook handling is idempotent, keyed on the provider's event id. Payment
providers guarantee at-least-once delivery, not exactly-once, so every event is
claimed before it is acted on. Without that, a retried charge event
double-counts a payment and a retried failure cancels a subscription that only
failed once.

Signature verification uses a constant-time comparison, and a blank webhook
secret fails closed at boot rather than silently making every forged webhook
verifiable.

A failed charge does not cancel a subscription. It moves the account to a grace
period and keeps service running - most failures are expired cards, not
customers leaving.

Implemented with Razorpay UPI Autopay. The same architecture applies to Stripe:
see [stripe-subscription-demo](https://github.com/rahulydav-dev/stripe-subscription-demo).

### Zone capacity and route assignment

Each washer covers a geographic zone with a hard daily capacity - there are only
so many cars one person can clean before residents leave for work.

Zones are built from H3 geospatial cells, so coverage is exact and two zones
cannot claim the same ground. The system validates service-area coverage at
signup, caps new subscriptions per zone against washer availability, calculates
the hiring gap between subscribed cars and active washers, and assigns each
morning's jobs into a route ordered by building and parking level.

### Proof of service

Disputes over "was my car actually cleaned" are the main support cost in this
business. Every wash requires before/after photos captured in the washer app and
attached to the job record, visible to the customer in their app and to support
staff in the console. Support can resolve a complaint without calling anyone.

---

## Code samples

Selected files from the production codebase.

| File | What it shows |
|---|---|
| [`samples/payment-provider.ts`](samples/payment-provider.ts) | HMAC webhook verification, mandate creation, fail-closed secret validation |
| [`samples/payments.service.ts`](samples/payments.service.ts) | Idempotent webhook handling, subscription activation, invoice generation |
| [`samples/washer-zone-capacity.ts`](samples/washer-zone-capacity.ts) | Zone capacity and hiring-gap calculation |

---

## Screenshots

| | |
|---|---|
| ![Customer app](screenshots/customer-app.jpg) | ![Washer app](screenshots/washer-app.jpg) |
| **Customer app** - subscribe, track today's wash, view proof | **Washer app** - daily route, check-in, completion |
| ![Hub console](screenshots/hub-console.png) | ![Support console](screenshots/support-console.png) |
| **Hub console** - daily operations | **Support console** - subscriber lookup, call logging |

---

## Contact

Built by Rahul Yadav - Flutter and React developer, available for freelance work.

[Upwork](https://www.upwork.com/freelancers/~019ee639912f09926c) | [GitHub](https://github.com/rahulydav-dev)
