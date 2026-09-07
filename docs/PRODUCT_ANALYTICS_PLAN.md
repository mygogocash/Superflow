# Product analytics plan — GA + Mixpanel + admin monitor

**Status:** plan only (no SDK wiring in this PR).  
**Audience:** platform / product.  
**Related:** `.telemetry/tracking-plan.yaml`, `.telemetry/product.md`, Admin Usage tab (`apps/web` + `apps/api` admin usage).

---

## 0. Current reality (do not ignore)

| Fact | Implication |
|---|---|
| Product telemetry today is **PostHog only** (`apps/web` + Express; edge `/ingest` proxy) | GA + Mixpanel are **additive destinations**, not a greenfield blank slate |
| Official client is **Expo** (`apps/app`) — **no** product SDK there yet | Instrument Expo first; Next.js (`apps/web`) is legacy UI |
| Tenancy is **single-tenant SaaS**, multi-**entity** (TH / IN / VN / ID legal companies) | “Per org” in this product = **per `Entity`**, unless we invent a real `Organization` tenant model |
| Marketing Analytics (`/marketing-analytics`) is **BNII / OneWave telco data** | Separate product; **do not** put GA/Mixpanel admin under that module |
| Edge deploy cannot run `posthog-node` HogQL the same way as Express | Admin “query Mixpanel/GA/PostHog APIs” needs `fetch`-based core services or stays Node/501 until ported |

Goal of telemetry (unchanged from `.telemetry/product.md`):

> Which modules are used, where funnels drop, what is dead weight — **per entity**.

---

## 1. Product decisions (resolve before build)

### 1.1 Destination roles

Keep **one tracking plan**, fan out to destinations with clear jobs:

| Destination | Role | Why |
|---|---|---|
| **PostHog** (keep) | Product analytics + HogQL admin rollups + session replay (if enabled) | Already wired; Admin Usage already reads HogQL |
| **Mixpanel** | Product funnels, retention, cohort compare **by entity** | Strong product UI for module adoption / funnels; good Group Analytics |
| **Google Analytics 4** | Aggregate web traffic, acquisition, page/screen views, cross-platform if App+Web | Better for “site health” and Google ads ecosystem; weaker for B2B CRM funnels |

**Rule:** call sites never import `gtag` / `mixpanel` / `posthog` directly. Only `tracking.capture | identify | group | page` from a shared chokepoint.

### 1.2 What “org” means

**Recommended (phase 1):** treat **Entity** as the org unit.

- Identify user → `distinct_id = user.id`
- Group → Mixpanel Group / PostHog `group("entity", entityId)` / GA4 `user_properties.entity_code`
- Admin panel filter = entity picker (TH / IN / VN / ID / All)

**Only if** Manut becomes multi-customer SaaS later: add `Organization` (tenant) above Entity, migrate groups to `organization` + nested `entity`. That is a schema + RBAC project — **out of scope** for this analytics plan.

### 1.3 Consent / privacy

Internal staff tool (~50 users today): PII in **traits only** (email, name) per tracking plan. Still:

- Fail closed outside production (`TELEMETRY_ENABLED` / `EXPO_PUBLIC_TELEMETRY_ENABLED === "true"`).
- No secrets in event props; no free-text leave reasons / salary / bank details in analytics.
- Document GA4 + Mixpanel DPAs; store keys as secrets (Depot + Wrangler), never in git.

---

## 2. Architecture

```
Expo / (legacy Next) UI
        │
        ▼
 apps/app/src/lib/tracking.ts   ← NEW chokepoint (Expo)
 apps/web/src/lib/tracking.ts   ← extend existing
        │
        ├─► PostHog  (via edge /ingest proxy — keep)
        ├─► Mixpanel (browser SDK or /mp first-party proxy)
        └─► GA4      (gtag / gtag.js or Measurement Protocol server)

Server (edge @nexora/core + Express legacy)
        │
        ▼
 packages/core/.../tracking.ts  ← multi-destination; fetch-based on Workers
        │
        ├─► Mixpanel Import / Engage API
        ├─► GA4 Measurement Protocol
        └─► PostHog capture (when Node available) or skip on edge

Admin UI  /admin/analytics
        │
        ▼
 Edge routes  /api/admin/analytics/*
        │
        ├─► Mixpanel Query / Engage (server token)
        ├─► GA4 Data API (service account)
        └─► PostHog HogQL (existing pattern; edge may 501 until fetch port)
```

### 2.1 Shared contract

1. Extend `.telemetry/tracking-plan.yaml` `destinations:` → `posthog`, `mixpanel`, `ga4`.
2. Keep typed wrappers (`events.ts`) as the only event names.
3. Map destinations:
   - Mixpanel: same event name; `entity_id` as group key (`$group_key` / Group Analytics).
   - GA4: `event_name` snake_case ≤40 chars; entity as user property + event param; use recommended events only where they fit (`login`, `page_view`); custom events for module funnels.

### 2.2 Proxies (edge)

Mirror `apps/edge/src/proxy/posthog.ts`:

| Path | Upstream |
|---|---|
| `/ingest/*` | PostHog (exists) |
| `/mp/*` | `api.mixpanel.com` (optional first-party) |
| `/ga/*` | GA collect endpoint (optional; often unnecessary if gtag hits Google directly) |

Register before SPA fallback in `apps/edge/src/app.ts`.

### 2.3 Env / flags

Fail-closed public flags + secrets (add to `turbo.json` `globalEnv`, Expo export env, Wrangler secrets):

| Var | Surface |
|---|---|
| `EXPO_PUBLIC_TELEMETRY_ENABLED` | Expo |
| `EXPO_PUBLIC_POSTHOG_KEY` / host | Expo |
| `EXPO_PUBLIC_MIXPANEL_TOKEN` | Expo |
| `EXPO_PUBLIC_GA4_MEASUREMENT_ID` | Expo |
| `MIXPANEL_SECRET` / service account | Server admin queries |
| `GA4_PROPERTY_ID` + service account JSON | Server admin queries |
| Existing `POSTHOG_*` | Keep |

Ship dark behind `TELEMETRY_ENABLED` / per-destination flags if needed (`MIXPANEL_ENABLED`, `GA4_ENABLED`).

---

## 3. Instrumentation phases

### Phase A — Foundation (Expo + facade)

- Add `apps/app/src/lib/tracking.ts` + `events.ts` (port from web).
- On auth bootstrap (`useAuth` / session load): `identify`, `group(entity)`, optional `page`.
- Wire shell route changes → `screen_view` / `page_view` (Expo Router pathname).
- Server: multi-destination facade in `@nexora/core` used by edge routes that already call telemetry (or no-op cleanly on Workers).

**Exit:** events visible in Mixpanel Live View + GA4 DebugView + PostHog for one login + one leave submit.

### Phase B — Module funnels (tracking plan)

Prioritize high-value actions already named in `.telemetry/product.md`:

1. Leave / Expenses / Travel submit funnels  
2. ARIA / Manut AI message sent  
3. CRM deal/lead created  
4. Admin-heavy: payroll run, user invite  

Emit `*.started` + `*.submitted` (+ `*.failed` where useful). No UI redesign required — hooks in existing mutation success paths.

### Phase C — Destination polish

- Mixpanel Group Analytics profiles for each Entity.  
- GA4 custom dimensions: `entity_code`, `module`, `client` (`expo` / `next`).  
- Deduplicate: browser capture for UI; server capture only for backend-only events (cron, webhooks) to avoid double-counting.

---

## 4. Admin panel — manage, monitor, analyze

### 4.1 Placement

New Expo + legacy Next surface under **Admin**, not Marketing:

- Expo: `apps/app/app/(dashboard)/admin/analytics/`  
- Mirror Next: `apps/web/src/app/(dashboard)/admin/analytics/` (parity until Next retired)  
- Nav: Admin → **Product analytics**  
- Permission: reuse / extend `admin:usage-report` **or** mint `admin:analytics` (seed Admin role only). Prefer **one** code; don’t invent a parallel gate without need.

### 4.2 Information architecture (one job per tab)

| Tab | Job | Primary data source |
|---|---|---|
| **Overview** | Org/entity health: DAU/WAU/MAU, active modules, wow growth | Mixpanel Insights or PostHog HogQL |
| **By entity** | Compare TH / IN / VN / ID adoption | Group / entity filter |
| **Funnels** | Leave / Expense / Travel / AI conversion | Mixpanel Funnels API or cached snapshots |
| **Modules** | Dead-weight table: events last 7/28d per module | Mixpanel / PostHog |
| **Traffic** | Sessions, landing, device, web vs native | GA4 Data API |
| **Sources** | Connection health: last event age, error rate, flag state | Internal + destination health checks |
| **Settings** | Enable/disable destinations (fail-closed), retention notes, PII reminder | `SystemSetting` + env echo (no secret values) |

Reuse Admin Usage patterns (`admin-usage.service`, activity table UI) for tables; Manut Brand CI for exhibits (no purple-glass dashboards).

### 4.3 “Manage”

Admin can:

1. Toggle destination enablement (env is source of truth; UI reflects + documents).  
2. Pick default entity scope for the panel.  
3. Trigger a **safe** re-sync of person/group traits (extend existing `sync-telemetry` cron conceptually; edge-jobs when enabled).  
4. **Not** edit Mixpanel/GA project settings inside Manut (link out to consoles).

### 4.4 “Monitor”

- Lag alert: “no events from Expo in 24h” → SystemSetting fingerprint debounce (same idea as marketing drift).  
- Error card: proxy 5xx rates for `/ingest` / `/mp`.  
- Optional: email admin list via existing Resend + `SystemSetting` recipients (best-effort).

### 4.5 “Analyze”

- Server aggregates into a stable DTO (`AdminAnalyticsSnapshot`) so the UI never embeds raw Mixpanel/GA JSON shapes.  
- Cache snapshot 5–15 min in memory / KV / `SystemSetting` to respect API quotas.  
- Entity filter always applied server-side — never trust client-only filters for cross-entity admin reads.

### 4.6 API sketch (edge-first)

```
GET  /api/admin/analytics/overview?entityId=&range=28d
GET  /api/admin/analytics/funnels/:key?entityId=
GET  /api/admin/analytics/modules?entityId=&range=28d
GET  /api/admin/analytics/traffic?range=28d          # GA4
GET  /api/admin/analytics/health
POST /api/admin/analytics/traits/sync                 # admin only
```

Gate: `requirePermission("admin:usage-report")` or `admin:analytics` + System Admin bypass via existing resolver. Implement services in `@nexora/core`; Hono routes in `apps/edge/src/routes/admin-analytics.ts`. If a destination client is Node-only, return structured 501 with `reason` (same as admin-usage PostHog on edge) until `fetch` port lands.

---

## 5. Build order (technical, not calendar)

1. **Contract** — update tracking plan destinations + docs; decide permission code.  
2. **Expo tracking facade** — PostHog + Mixpanel + GA4 behind flags; identify/group on login.  
3. **Edge proxies** (optional Mixpanel) + secrets in Depot/Wrangler.  
4. **Core admin snapshot service** — start with Mixpanel + existing PostHog; GA4 traffic tab second.  
5. **Admin UI** — Overview + By entity + Health first; Funnels/Modules next; Traffic last.  
6. **Module event backfill** — instrument mutations per tracking plan (leave/expense first).  
7. **Parity** — thin Next admin page or deep-link to Expo-only once SPA is canonical.  
8. **Hardening** — quotas, caching, lag monitor, brand-contrast / a11y on charts.

---

## 6. Explicit non-goals

- Replacing PostHog in phase 1.  
- Putting product analytics inside Marketing Analytics / BNII.  
- Building a full BI warehouse (BigQuery/Snowflake) before destination APIs prove insufficient.  
- Client-side “select all entities” without server enforcement.  
- Tracking PII in event properties.  
- Multi-tenant `Organization` model (separate initiative).

---

## 7. Test plan (when implementing)

- [ ] Flag off → zero network calls to Mixpanel/GA/PostHog from Expo.  
- [ ] Flag on → identify + one capture in each destination debug view.  
- [ ] Entity group present on events after login with `entityId`.  
- [ ] Admin overview 403 without permission; 200 for Admin.  
- [ ] Entity filter changes series (TH ≠ All).  
- [ ] Edge type-check + Vitest for pure snapshot mappers.  
- [ ] No brand-drift hexes; charts use Manut tokens.

---

## 8. Open questions for stakeholders

1. Keep **all three** destinations long-term, or is GA4 optional (traffic only)?  
2. New permission `admin:analytics` vs reuse `admin:usage-report`?  
3. Is **Entity** the correct “org” grain, or is a future multi-customer tenant required in the same program?  
4. Should Mixpanel/GA replace any PostHog admin Usage features, or only extend them?
