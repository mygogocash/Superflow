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
| SEC-005 | 0 | P0/P1 | Org tenancy incomplete on ERP rows | open | Wave 3; see `docs/ORG_TENANCY_RBAC_PLAN.md` | |
| SEC-006 | 0 | P1 | Cron/webhook secret compare | open | Wave 4: timing-safe + fail-closed empty secret | |
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
- Cross-tenant IDOR remains Wave 3 (ERP rows still globally scoped).

