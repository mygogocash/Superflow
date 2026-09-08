# Stripe Billing plan — Organization SaaS

**Status:** plan (architecture contract).  
**Driver:** charge each customer **Organization** for Manut platform access.  
**Related:** `docs/ORG_TENANCY_RBAC_PLAN.md` (tenant + who can bill), edge Worker deploy secrets, Depot CI.  
**Stripe account context:** GoGoCash / Manut platform (direct Billing — **not** Connect in v1).  
**API:** use latest Stripe API (`2026-07-29.dahlia` or newer) + Node SDK via `StripeClient` instance (never global `stripe.api_key`).

---

## 0. Product shape (locked for v1)

| Decision | Choice | Why |
|---|---|---|
| Who is the Stripe Customer? | **Organization** (1 Customer ↔ 1 org) | Matches tenancy; seats/users are subscription quantity, not Customers |
| Monetization | **Stripe Billing** subscriptions | Recurring SaaS; no PaymentIntent renewal loops |
| Checkout UI | **Hosted Checkout** (`mode: 'subscription'`) | Fastest secure path; Worker-friendly (redirect, no Elements PCI surface) |
| Self-serve manage | **Customer Portal** | Upgrade / cancel / payment method / invoices with almost no UI code |
| Pricing v1 | **Flat-rate Products** (Starter / Pro / Enterprise) | One Product per plan name; monthly + annual Prices on each Product |
| **Currency** | **THB only in v1** | All Prices `currency: thb`; multi-currency later if needed |
| Seats | **Optional Phase 2** — per-seat Price `quantity` = active memberships | Don’t block v1 on seat sync |
| **Home org `manut`** | **Always complimentary** | Seed `billingExempt=true` / `billingStatus=complimentary`; never create a paid Subscription |
| **Trial** | **Trial with card on file** | Checkout collects PM; default **14 days** (`trial_period_days`, Dashboard-tunable) then auto-charge |
| **Past-due grace** | **30 calendar days** after first `invoice.payment_failed` | See §0.1 — product policy, not a Thai statutory SaaS minimum |
| Sales-led | **Later:** Quotes + `collection_method: send_invoice` | SMB self-serve first; enterprise NET terms phase 3 |
| Connect / marketplace | **None** | Manut charges orgs directly |
| IT Billing module (`it_subscriptions`) | **Unrelated** | Internal vendor spend tracker — do not reuse those tables for SaaS billing |

### 0.1 Past-due grace (TH)

Thai B2B SaaS has **no fixed statutory “must keep access N days”** rule for subscription software (BOT default-interest grace rules target **financial lenders**, not SaaS access). Local recurring-billing practice often uses a short 3–7 day soft window while Smart Retries run.

**Manut policy (locked):** keep **full access for 30 calendar days** from the first unpaid invoice failure (`past_due_since`), show a persistent billing banner, run Stripe Smart Retries (align retries with Thai salary cycles where possible), email Org Super Admins. On day 31 without `invoice.paid` → hard lock writes (read-only or full lock — product: **write lock, read OK**). Counsel can tighten ToS language; 30 days is intentionally customer-friendly above market default.

```
Manut Platform (Stripe account)
 └── Organization (tenant)
      ├── stripeCustomerId
      ├── Subscription (Stripe) → plan + status
      └── Org Super Admin may open Checkout / Portal
```

---

## 1. Catalog (Dashboard or API once)

**Rule:** one **Product** per plan customers can name; Prices = billing variants (month/year), never different tiers on one Product.

| Product | Example Prices (all **THB**) |
|---|---|
| `Manut Starter` | `price_…_month_thb`, `price_…_year_thb` |
| `Manut Pro` | `price_…_month_thb`, `price_…_year_thb` |
| `Manut Enterprise` | custom / Quote later; optional list Price for self-serve |

Store Price IDs in Worker vars / secrets (`STRIPE_PRICE_STARTER_MONTH`, …) — **not** hardcoded in client bundles. Reject Checkout if Price currency ≠ `thb`.

Phase 2 seats: add a second line item Price with `usage_type: licensed` (or per-unit) and set `quantity` from `organization_memberships` count (active).

---

## 2. Data model (add onto Organization)

Extend `organizations` (from org-tenancy work):

```prisma
model Organization {
  // …existing…
  stripeCustomerId     String?   @unique @map("stripe_customer_id")
  stripeSubscriptionId String?   @unique @map("stripe_subscription_id")
  billingExempt        Boolean   @default(false) @map("billing_exempt") // home org manut + Platform comps
  billingStatus        String    @default("none") // none | complimentary | trialing | active | past_due | canceled | unpaid | incomplete
  planKey              String?   @map("plan_key") // starter | pro | enterprise | home
  currentPeriodEnd     DateTime? @map("current_period_end")
  pastDueSince         DateTime? @map("past_due_since") // set on first payment_failed; clear on invoice.paid
  trialEndsAt          DateTime? @map("trial_ends_at")
  // seatQuantity        Int?     // phase 2
}
```

Optional audit table `organization_billing_events` (stripe event id unique, type, payload summary) for support + idempotent webhook replay.

**Entitlement rule (fail closed):**

```
allowed =
  billingExempt
  OR billingStatus ∈ { complimentary, trialing, active }
  OR (billingStatus = past_due AND now < pastDueSince + 30 days)
  OR platformAdminSupportMode
```

- Home org `manut`: seed `billingExempt=true`, `billingStatus=complimentary`, `planKey=home`. Never attach a paid Stripe Subscription.
- Customer orgs after Checkout: `trialing` while trial runs (card on file); then `active` on first successful charge.
- Day 0–30 of `past_due`: full access + banner + Super Admin emails.
- Day 31+: **write lock** (reads may remain) until paid or canceled.
- Platform Admin may set `billingExempt` / `complimentary` for pilots (audit-logged).

Do **not** trust client-reported plan; only webhook-updated columns (or live Stripe retrieve in Platform Admin tools).

---

## 3. Authz matrix (billing)

| Action | Org User | Org Admin | Org Super Admin | Platform Admin |
|---|---|---|---|---|
| See plan / invoices summary | — | ✓ | ✓ | ✓ |
| Start Checkout / change plan | — | — | ✓ | ✓ |
| Open Customer Portal | — | — | ✓ | ✓ |
| Set complimentary / override status | — | — | — | ✓ |
| Create org without payment | — | — | — | ✓ (`billingExempt` / complimentary pilot, or send Super Admin into Checkout+trial) |

Gate routes with existing org RBAC (`isOrgSuperAdminRole` / `isPlatformAdmin`) — no new permission code required for v1 if Super Admin owns billing; optional later: `billing:manage`.

---

## 4. API surface (edge-first)

Mount under `/api/billing` (Hono on Workers; Express parity optional):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/checkout-session` | Body: `{ priceId }` or `{ planKey, interval }`. Creates/ensures Stripe Customer, returns `{ url }` |
| `POST` | `/portal-session` | Returns Customer Portal URL for org’s `stripeCustomerId` |
| `GET` | `/subscription` | Read-model from DB (status, planKey, period end) |
| `POST` | `/webhooks/stripe` | Raw body + `Stripe-Signature`; **no session auth** |

Checkout Session create (sketch):

```ts
await stripe.checkout.sessions.create({
  mode: "subscription",
  customer: org.stripeCustomerId,
  line_items: [{ price: priceId, quantity: 1 }],
  success_url: `${APP_URL}/org/billing?checkout=success`,
  cancel_url: `${APP_URL}/org/billing?checkout=cancel`,
  client_reference_id: organizationId,
  metadata: { organizationId },
  subscription_data: {
    metadata: { organizationId },
    trial_period_days: 14, // locked default; Dashboard-tunable
    billing_mode: { type: "flexible" },
  },
  payment_method_collection: "always", // trial WITH card on file
  // omit payment_method_types — dynamic methods
  // automatic_tax: { enabled: true } ONLY after TH (and other) Tax registrations exist
});
```

Reject Checkout for `billingExempt` orgs (home / comps) — they must not enter a paid Subscription by accident.

Customer + subscription metadata **must** include `organizationId` so webhooks can resolve the tenant without guessing by email.

Portal:

```ts
await stripe.billingPortal.sessions.create({
  customer: org.stripeCustomerId,
  return_url: `${APP_URL}/org/billing`,
});
```

---

## 5. Webhooks (source of truth)

Endpoint: Worker route `POST /api/billing/webhooks/stripe`.

**Verify** signature with `STRIPE_WEBHOOK_SECRET`. On Cloudflare Workers, read **raw** body bytes before JSON parse.

Handle at minimum:

| Event | Action |
|---|---|
| `checkout.session.completed` | Attach `subscription` + customer ids to org; set plan from Price |
| `customer.subscription.created/updated` | Sync `billingStatus`, `planKey`, `currentPeriodEnd`, `stripeSubscriptionId` |
| `customer.subscription.deleted` | `canceled` / clear period; revoke entitlement |
| `invoice.paid` | Confirm `active`; clear `pastDueSince` |
| `invoice.payment_failed` | Set `past_due`; set `pastDueSince` **only if null** (grace clock starts once); notify Org Super Admins |
| `customer.subscription.trial_will_end` | Optional reminder email ~3 days before trial ends |
| `customer.updated` | Optional billing email sync |

Idempotency: unique on `event.id`. Never provision from Checkout success_url alone (user can bookmark / skip).

Enable Dashboard **Smart Retries** + failed-payment emails (Revenue Recovery). Prefer retry cadence that covers Thai salary cycles (late-month). Custom dunning only if sales escalation needed beyond the 30-day grace.

---

## 6. Secrets & env

| Secret / var | Where |
|---|---|
| `STRIPE_SECRET_KEY` | Restricted API key (`rk_…`) preferred over `sk_…`; `wrangler secret` + Depot |
| `STRIPE_WEBHOOK_SECRET` | Per env (staging vs prod endpoints) |
| `STRIPE_PRICE_*` | `vars` in `wrangler.jsonc` (non-secret Price ids OK) |
| Publishable key | Only if we later embed Elements; **not** needed for hosted Checkout |

Add keys to `turbo.json` `globalEnv`. Staging uses Stripe **test mode** keys; production live keys. Two webhook endpoints (or one endpoint + two secrets carefully — prefer separate Worker env).

---

## 7. UI

### Org (`/org/billing` or settings Billing tab)

- Current plan + status + renew / trial end date  
- CTA: “Start trial / Subscribe” → `POST /checkout-session` → redirect (card required)  
- CTA: “Manage billing” → Portal  
- Banner while `trialing` (days left) and while `past_due` (days left in 30-day grace)  
- Harder banner + write-blocked UI after day 31  

### Platform (`/platform/orgs/:id`)

- Stripe customer / subscription ids (read-only links to Dashboard)  
- Comp / force-active (audit-logged) for pilots  
- Plan filter on org directory  

Expo official client first; Next legacy optional.

---

## 8. Tax (do not skip)

SEA / Thailand B2B SaaS:

1. Start with **Stripe Tax threshold monitoring** + product tax codes on Products.  
2. Before enabling `automatic_tax: { enabled: true }` on Checkout, add **active Tax registrations** for every jurisdiction you must collect in. Enabling the flag without registrations collects **$0 tax silently**.  
3. Prefer customer tax IDs (VAT / tax number) on Customer for B2B invoices when registering.

See: [Collect taxes for recurring payments](https://docs.stripe.com/billing/taxes/collect-taxes).

---

## 9. Build order

1. **Docs + catalog** — this plan; create Products/Prices in test mode; record Price ids.  
2. **Schema** — billing columns on `organizations` (+ optional events table); migration idempotent.  
3. **Stripe client module** — `@nexora/core` (or edge-local) `StripeClient`, no secrets in logs.  
4. **Checkout + Portal** routes + Super Admin gates.  
5. **Webhook** handler + status sync + entitlement gate on a single vertical (e.g. users write).  
6. **Org billing UI** + past_due banner.  
7. **Platform** org billing panel + comp override.  
8. **Recovery** — Smart Retries; Super Admin email on `invoice.payment_failed`.  
9. **Phase 2** — seat quantity sync; **Phase 3** — Quotes / send_invoice enterprise.  
10. Live mode + Tax registrations when first taxable market goes live.

---

## 10. Explicit non-goals (v1)

- Stripe Connect / connected accounts for customers  
- Metronome / usage-based AI metering (revisit if Manut AI is metered)  
- Building a custom portal (use Customer Portal)  
- Coupling to Accounting AR / `it_subscriptions`  
- Client-side Price amounts (always Price id from server)

---

## 11. Locked product decisions

| # | Question | Decision |
|---|---|---|
| 1 | Primary currency | **THB** (v1 Prices only) |
| 2 | Home org `manut` | **Complimentary** (`billingExempt`) |
| 3 | Past-due grace | **30 calendar days** full access, then write lock (no Thai statutory SaaS minimum found; policy is intentional goodwill) |
| 4 | Trial | **With card** · default **14 days** · `payment_method_collection: always` |

### Still open (non-blocking)

- Exact Starter / Pro / Enterprise THB list prices and annual discount %  
- Seat definition for Phase 2 (all active memberships vs billable roles only)  
- Whether day-31 lock is read-only vs full logout wall  
- Trial length override per campaign (Promo codes / Dashboard)  

---

## 12. Test plan (when implementing)

- [ ] Test-mode Checkout with trial → `billingStatus=trialing`, card saved, `trialEndsAt` set  
- [ ] After trial charge succeeds → `active`  
- [ ] Home org never gets a Stripe Subscription; Checkout rejected if attempted  
- [ ] All Catalog Prices are `thb`  
- [ ] `invoice.payment_failed` sets `pastDueSince` once; access remains for 30 days  
- [ ] Day 31 simulated → writes blocked, banner shown  
- [ ] `invoice.paid` clears grace and restores writes  
- [ ] Portal cancel at period end → status updates via webhook only  
- [ ] Replay same `event.id` → no double writes  
- [ ] Org Admin cannot open Checkout; Super Admin can  
- [ ] Platform Admin can set complimentary; audit row written  
- [ ] Signature fail → 400; no DB mutation  
- [ ] Staging Worker secret + webhook endpoint registered in Stripe test Dashboard  
