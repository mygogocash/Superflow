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
| SEC-000 | 0 | — | inventory harness | done | Scripts + allowlist + this log | TBD |
| SEC-001 | 0 | P3 | HTML sinks without nearby sanitizer | open | 4 REVIEW rows: print CSS, chart CSS, Expo `RichHtml` (caller-must-sanitize) — Wave 5 | |
| SEC-002 | 0 | P2 | Workflow email-action public controller | open | `projects/workflow/workflow-public.controller.ts` uses `verifyActionToken`. Wave 4: replay/expiry/binding audit | |
| SEC-003 | 0 | P2 | Expo session in web storage | open | Wave 1: logout + XSS blast radius | |
| SEC-004 | 0 | P1 | Soft-delete restore IDOR pattern | open | Wave 2: owner-or-HR service checks | |
| SEC-005 | 0 | P0/P1 | Org tenancy incomplete on ERP rows | open | Wave 3; see `docs/ORG_TENANCY_RBAC_PLAN.md` | |
| SEC-006 | 0 | P1 | Cron/webhook secret compare | open | Wave 4: timing-safe + fail-closed empty secret | |
| SEC-007 | 0 | P2 | CF Access fail-open when AUD unset | open | Wave 1: document / require in prod | |
| SEC-008 | 0 | P3 | No CI audit/secret-scan gate | open | Wave 7 | |

## Wave 0 baseline (2026-09-08)

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
