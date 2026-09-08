# Security review log

Program plan: [`docs/superpowers/plans/2026-09-08-security-hardening-review.md`](../superpowers/plans/2026-09-08-security-hardening-review.md)

Inventory commands (Wave 0):

```bash
pnpm security:inventory
pnpm security:ungated-routes [--json] [--fail]
pnpm security:dangerously-html [--json] [--fail]
pnpm route-parity
```

Allowlist for intentional public / alt-auth surfaces: `scripts/security/allowlist.json`.

| id | wave | severity | surface | status | notes | PR |
|----|------|----------|---------|--------|-------|-----|
| SEC-000 | 0 | — | inventory harness | done | Scripts + allowlist + this log | #319 |
| SEC-001 | 0 | P3 | HTML sinks without nearby sanitizer | open | 4 REVIEW rows: print CSS, chart CSS, Expo `RichHtml` (caller-must-sanitize) — Wave 5 | |
| SEC-002 | 0 | P2 | Workflow email-action public controller | open | `projects/workflow/workflow-public.controller.ts` uses `verifyActionToken`. Wave 4: replay/expiry/binding audit | |
| SEC-003 | 0 | P2 | Expo session in web storage | mitigated | Wave 1: logout clears `intranet.session.v1` + legacy keys; residual XSS blast radius remains (Bearer-in-storage for Expo) | |
| SEC-004 | 0 | P1 | Soft-delete restore IDOR pattern | done | Wave 2: owner-or-HR/read-all in service for accounting restore + permanent delete IncludingDeleted | |
| SEC-005 | 0 | P0/P1 | Org tenancy incomplete on ERP rows | mitigated | Wave 3: `assertSameOrg` + users/membership scoping + `ORG_TENANCY_ENFORCED` fail-closed (users/org only). ERP column backfill still debt — see Wave 3 tenancy debt below | |
| SEC-006 | 0 | P1 | Cron/webhook secret compare | done | Wave 4: timing-safe + fail-closed empty/short secret (≥32) | |
| SEC-007 | 0 | P2 | CF Access fail-open when AUD unset | accepted | Wave 1: documented residual risk + compensating controls; set `CF_ACCESS_AUD` when Zero Trust is cut over | |
| SEC-008 | 0 | P3 | No CI audit/secret-scan gate | open | Wave 7 | |
| SEC-009 | 1 | P2 | RBAC KV not invalidated on role assign | done | `PUT /api/users/:id/roles` now calls `invalidateUserPermissions` | |

## Wave 1 — session / perimeter (2026-09-08)

### Session model decision

| Client | Credential storage | Notes |
|--------|-------------------|--------|
| Expo web / native (`apps/app`) | Bearer token in `intranet.session.v1` (localStorage or sessionStorage) | Required for React Native; XSS ⇒ account takeover. Logout must clear memory + both storages + legacy keys. Prefer migrating web-only surfaces to httpOnly cookies later. |
| Better Auth cookie session | httpOnly Secure cookies when `APP_URL` is https | Preferred for browser-only clients; Expo still dual-writes Bearer for native. |
| Legacy Express JWT (`apps/web` / api) | Cookie or Bearer depending on path | Parity surface only; edge is live. |

### Cloudflare Access env matrix

| Env | `CF_ACCESS_AUD` | Behavior | Residual risk / controls |
|-----|-----------------|----------|---------------------------|
| local (`wrangler.dev`) | empty | Fail-open | Expected for local DX |
| staging | empty (today) | Fail-open | Compensating: Turnstile on sign-in/magic-link, login + global rate limits, `TRUSTED_ORIGINS`, Bot Fight Mode |
| production | empty (today) | Fail-open | **Accepted until Zero Trust cutover.** Same compensating controls. When Access is enabled, set `CF_ACCESS_AUD` (+ optional `CF_ACCESS_TEAM_DOMAIN`) so `requireAccess` fails closed. |

### `TRUSTED_ORIGINS` audit

Better Auth `trustedOrigins` = `[APP_URL, ...TRUSTED_ORIGINS]`.

| Env | `APP_URL` | Extra `TRUSTED_ORIGINS` | Covers |
|-----|-----------|-------------------------|--------|
| local | `http://localhost:8787` | `intranet://,http://localhost:8081` | Worker origin, Expo scheme, Expo web |
| staging | `https://staging.manut.xyz` | `intranet://` | Staging host + native scheme |
| production | `https://manut.xyz` | `intranet://` | Prod host + native scheme |

Do **not** use `*` origins. Add any new Expo web preview host explicitly before shipping it.

### Permission cache

- KV key `rbac:{userId}`, TTL **60s**.
- `PUT /api/users/:id/roles` invalidates immediately via `invalidateUserPermissions`.
- Role-permission CRUD is not yet on edge (list-only); when it lands, invalidate all members of that role (or accept ≤60s window with a ticket).


### Ungated routes (`pnpm security:ungated-routes`)

- Edge: **92/94** files have auth markers; allowlisted public: `health.ts`, `index.ts`. Unexpected: **none**.
- Alt-auth (detected as gated): `cron.ts` (`verifyCron`), `line.ts` (`verifyLineSignature`).
- API: **95/99** controllers have auth markers; allowlisted session/alt: auth, organizations, push, uploads. Unexpected: **none** after recognizing `verifyActionToken` on workflow-public.

### HTML sinks (`pnpm security:dangerously-html`)

- 6 sinks; 2 use `sanitizeRichHtml` nearby; 4 REVIEW (static CSS ×2, Expo `RichHtml` escape hatch ×2).

### Route parity (`pnpm route-parity`)

- Express controller routes: **1316**; edge handlers: **1166**; ratio **0.886** (threshold 0.80) — **PASS**.

### Expected public allowlist (summary)

| Surface | Auth model |
|---------|------------|
| `/health` | None |
| `/api/auth/*` | Better Auth |
| `/api/cron/*` | Shared secret (`verifyCron` / cron controller) |
| `/api/line/webhook` | LINE HMAC (`verifyLineSignature`) |
| Workflow email-action | Signed token (`verifyActionToken`) |
| Helpdesk / legal public webhooks | Provider HMAC |
| PostHog `/ingest` proxy | Unauthenticated by design (`app.ts`) |

## Wave 2 — authz / soft-delete IDOR (2026-09-08)

### Findings closed

| Module | Gap | Fix |
|--------|-----|-----|
| Accounting journals/invoices | Restore lacked owner-or-read-all (esp. edge `ACCOUNTING_CREATE`) | `assertJournalAccess` / `assertInvoiceAccess` on restore; API + core + edge pass `actorId` + `permissions` |
| Travel / cash-advance / expenses | Permanent delete used live finder (404 on soft-deleted) and weak service authz | `*IncludingDeleted` lookup + HR/approver permission check in service; controllers pass `permissions` |

### Tests

- Accounting restore: owner OK, foreign actor 403, read-all OK, missing 404.
- Cash-advance permanent delete: approve OK, create-only 403.

### Residual

- Leave/visa restore paths were already owner-or-HR; spot-checked, no change.
- Approval-chain `assertCanActOnStep` identity checks unchanged this wave (already service-enforced).
- Cross-tenant IDOR for ERP rows addressed in Wave 3 readiness (invariants + debt list); full column backfill remains ORG plan work.

## Wave 3 — org tenancy readiness (2026-09-08)

### Landed

| Surface | Change |
|---------|--------|
| `@nexora/auth` `org-rbac` | `isSameOrg` / `assertSameOrg` / `OrgScopeError` / `isOrgTenancyEnforced` |
| Organizations service | `assertOrgResourceScope` on get/list-members/upsert/update when `tenancyEnforced` |
| Users service | Non–platform-admin list/get scoped to active-org members; IDOR on `getById`; fail-closed when `tenancyEnforced` and no active org |
| Edge | `ORG_TENANCY_ENFORCED` (default `false`) wired through users + organizations routes |
| Inventory | `pnpm security:tenancy-inventory` — Prisma models with vs without `organizationId` |

### Flag semantics

| `ORG_TENANCY_ENFORCED` | Behavior |
|------------------------|----------|
| unset / `false` | Soft: no active org → empty user list; get still denies cross-org members |
| `true` | Fail-closed on users + org membership: missing active org → 403 |

Platform admin (`platform_admin`) bypasses org scope. Org Super Admin does **not** get platform bypass.

### Tenancy debt (ordered by PII / finance sensitivity)

`pnpm security:tenancy-inventory` (2026-09-08): **2 / 281** models have `organizationId` (`Entity`, `OrganizationMembership`). Everything else is application-layer debt until backfilled per `docs/ORG_TENANCY_RBAC_PLAN.md`.

| Priority | Domain | Why first | Notes |
|----------|--------|-----------|-------|
| P0 | Payroll / compensation | Salary, tax IDs, bank-adjacent fields on users + payslips | Highest cross-tenant blast radius |
| P0 | Expenses / cash-advance / travel | Finance PII + approval artifacts | Soft-delete IDOR hardened in Wave 2; still no `organizationId` |
| P1 | Accounting (journals / invoices / FA) | Statutory ledgers, amounts | Restore authz Wave 2; column still global |
| P1 | Leave / attendance / visa | HR PII | Owner-or-HR today; not org-keyed |
| P2 | CRM (sales / investor / project boards) | Customer + deal data | Large surface; stage after HR/finance |
| P3 | Content / comms / wall / news | Lower sensitivity | Last for column backfill |
| — | Auth / org tables | Already scoped | Membership + Entity only today |

Do **not** claim multi-org ERP is done until debt rows above carry `organizationId` (or equivalent RLS) and handlers filter on active org.

## Wave 4 — webhooks / cron secrets (2026-09-08)

### Landed

| Surface | Change |
|---------|--------|
| `@nexora/auth` `secrets` | `timingSafeEqualString` + `verifySharedSecret` (fail-closed empty/short, min 32) |
| Edge cron | Uses `verifySharedSecret`; empty/short `CRON_SECRET` → 401 |
| Express cron | Node `timingSafeEqual` + min length 32 (local copy; no api→auth dep) |
| Edge-jobs HTTP cron | Refuses to call edge unless `CRON_SECRET.length >= 32` |
| LINE / GitHub / DocuSign | Already HMAC + fail-closed when secret unset (spot-checked) |

### Webhook verification matrix

| Provider | Raw body | Signature header | Compare | Empty secret | Rotation owner |
|----------|----------|------------------|---------|--------------|----------------|
| Cron (edge + Express) | n/a (shared bearer) | `x-cron-secret` or `Authorization: Bearer` | Timing-safe string equal | Reject (401 / not configured) | Platform eng — Worker secret / Depot |
| LINE Messaging | Request text | `x-line-signature` | HMAC-SHA256 → base64, const-time | 503 `NOT_CONFIGURED` | Platform eng — `LINE_MESSAGING_CHANNEL_SECRET` |
| GitHub (helpdesk) | `req.rawBody` | `x-hub-signature-256` | HMAC-SHA256 hex, `timingSafeEqual` | 503 not configured | IT Helpdesk admin (per-workspace secret) |
| DocuSign Connect | Raw body | `x-docusign-signature-1` | HMAC-SHA256 base64, const-time | 500 `DOCUSIGN_HMAC_SECRET` missing | Legal / platform eng |
| Stripe (planned) | Raw body | `Stripe-Signature` | Stripe SDK constructEvent | Must fail-closed when unset | Billing — see `docs/STRIPE_BILLING_PLAN.md` |

### Edge-jobs allowlist

`apps/edge-jobs` HTTP cron consumer posts only to `/api/cron/<JobName>` for the fixed `ALL_JOBS` list with `X-Cron-Secret`. No arbitrary path fan-out.

### Residual

- Staging/prod operators must rotate any `CRON_SECRET` shorter than 32 chars before Wave 4 deploy (fail-closed).
- Workflow email-action token replay/expiry audit remains SEC-002 (not cron HMAC).

