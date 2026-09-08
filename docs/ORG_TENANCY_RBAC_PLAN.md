# Multi-org tenancy + RBAC plan

**Status:** plan (architecture contract).  
**Driver:** each customer **Organization** has its own User / Admin / Super Admin; **Manut platform** can manage every org.  
**Related:** `docs/PRODUCT_ANALYTICS_PLAN.md`, `docs/AUTH_RBAC.md`, `packages/database/prisma/schema/rbac.prisma`, `Entity` in `core.prisma`.

---

## 0. Current vs target

| Today | Target |
|---|---|
| One customer deployment (TBH / Manut internal) | Many **Organizations** (tenants) on one Manut platform |
| Global `Role` + `UserRole` (permissions merged app-wide) | **Org-scoped membership + org role** |
| System Admin = `Role.isSystem && name === "Admin"` (bypasses all gates) | Split into **Platform Admin** (Manut team) vs **Org Super Admin** (customer) |
| `Entity` = legal company (TH/IN/VN/ID) under one tenant | `Entity` stays **legal company inside an Organization** (1 org → N entities) |

```
Manut Platform
 └── Organization (customer / tenant)          ← NEW
      ├── OrgMembership (user ↔ org + orgRole)
      ├── Entity (legal company: TH, …)        ← existing, add organizationId
      └── …all ERP rows scoped by org (+ entity where needed)
```

---

## 1. Role model (three org tiers + platform)

### 1.1 Per Organization

| Org role | Who | Can |
|---|---|---|
| **User** | Normal staff | Use modules granted by org permission set; see only own org data |
| **Admin** | Customer IT / HR ops | Invite users, assign User/Admin (not Super Admin by default), manage org settings, view org analytics |
| **Super Admin** | Customer owner | Everything Admin + assign/revoke Admin & Super Admin, billing/owner actions, delete/deactivate org (if product allows) |

Rules:

- Roles are **per membership**, not global. Same person can be User in Org A and Super Admin in Org B.
- Org Admin **cannot** see other orgs.
- Permission codes stay `module:action`, but resolution becomes:  
  `platform bypass` **OR** (`membership in activeOrg` **AND** org-role grants / org role→permission map).

### 1.2 Manut platform (cross-org)

| Platform role | Who | Can |
|---|---|---|
| **Platform Admin** | Manut team | List/create/suspend orgs, impersonate-or-act-as support (audited), assign org Super Admin, view **all-org** analytics admin |
| **Platform Operator** (optional) | Manut support | Read-only across orgs + limited user reset; no billing destroy |

Platform Admin is **not** an org Super Admin copy. It is identity-checked (e.g. `User.platformRole = platform_admin` or a system flag), similar spirit to today’s `requireSystemAdmin()` but **renamed and scoped** so a customer Super Admin never gets cross-tenant power.

**Critical:** today’s “Admin role bypasses every permission” must **not** transfer to org Admin. Only Platform Admin (and optionally Org Super Admin within one org) gets broad bypass — and Org Super Admin bypass is **org-scoped**.

---

## 2. Data model (sketch)

```prisma
model Organization {
  id          String   @id @default(cuid())
  name        String
  slug        String   @unique
  status      String   // active | suspended | provisioning
  // plan / billing fields later
  createdAt   DateTime
  updatedAt   DateTime
  deletedAt   DateTime?
  entities    Entity[]
  memberships OrganizationMembership[]
}

enum OrgRole {
  user
  admin
  super_admin
}

model OrganizationMembership {
  id             String   @id
  organizationId String
  userId         String
  orgRole        OrgRole
  isActive       Boolean  @default(true)
  invitedById    String?
  createdAt      DateTime
  @@unique([organizationId, userId])
  @@index([userId])
}

// Entity gains:
// organizationId String  (required after backfill)
```

Optional later: `OrgRolePermission` if User/Admin/Super Admin need customizable module packs per org. Phase 1 can hardcode three templates:

| Org role | Permission pack |
|---|---|
| user | baseline employee modules (`leave:read`, `expense:read`, …) |
| admin | user pack + `*:hr-read` / invite / org settings / org analytics |
| super_admin | admin pack + membership role changes + org danger zone |

Keep existing fine-grained `module:action` codes; map org roles → seed packs so we don’t invent a parallel permission language.

### 2.1 Active org context

Every authenticated request carries:

- `userId`
- `platformRole?`
- `activeOrganizationId` (from session / header / membership default)
- Resolved `orgRole` for that org
- Merged permission codes for that org

Switching org (if multi-membership) is an explicit session action; lists/APIs always filter `organizationId = activeOrganizationId` unless Platform Admin is in “all orgs” mode.

---

## 3. Authorization matrix (summary)

| Action | User | Org Admin | Org Super Admin | Platform Admin |
|---|---|---|---|---|
| Use module data in own org | ✓ (perms) | ✓ | ✓ | ✓ (support mode) |
| Invite User | — | ✓ | ✓ | ✓ |
| Promote to Org Admin | — | ✓* | ✓ | ✓ |
| Promote to Org Super Admin | — | — | ✓ | ✓ |
| Manage other orgs | — | — | — | ✓ |
| Create / suspend org | — | — | — | ✓ |
| All-org analytics console | — | — | — | ✓ |
| Org analytics console | — | ✓ | ✓ | ✓ |

\*Org Admin promoting to Admin: product choice — default **yes**; demoting Super Admin: **Super Admin or Platform only**.

---

## 4. Admin UIs

### 4.1 Org admin (customer)

Route prefix: `/org/settings` or `/admin` **inside org context**

- Members: invite, role change, deactivate  
- Entities: manage legal companies under this org  
- Org product analytics (Mixpanel/GA scoped to `organization_id`)  
- Audit log (org-scoped)

### 4.2 Manut platform admin

Route prefix: `/platform` (hard-separated from org admin)

- Org directory (search, status, plan)  
- Create org + first Super Admin  
- Suspend / reopen  
- Support: open org as Platform Admin (banner + audit)  
- **All-org analytics** (GA / Mixpanel / PostHog grouped by `organization_id`)  
- Platform operators list  

Never reuse the same “Admin” nav item for both — Platform vs Org must be visually and route-distinct (Brand CI: clarity over cleverness).

---

## 5. Migration strategy (from today’s single tenant)

1. **Introduce `Organization`** — create one row `Manut / TBH` (slug `manut`).  
2. **Backfill** `entities.organizationId` → that org; all users → `OrganizationMembership` with roles mapped from current global roles:
   - system Admin → **Platform Admin** (Manut team only; confirm list) **and/or** Org Super Admin on the home org  
   - custom elevated roles → Org Admin  
   - everyone else → Org User  
3. **Thread `organizationId`** into hot write paths and list `WHERE` clauses (start with users, memberships, then module tables — or enforce via entity→org join initially).  
4. **Replace global Admin bypass** with Platform Admin + org-scoped Super Admin.  
5. **Invite flow** becomes org-scoped (token carries `organizationId`).  
6. **Analytics** groups: `organization` primary; `entity` secondary (see analytics plan).

Idempotent SQL; staging uses `db:push` so ship data backfill via Depot `db-backfill` script.

---

## 6. Analytics coupling

With true orgs:

| Level | Analytics group key |
|---|---|
| Platform | no group / Manut internal |
| Organization | `organization_id` (Mixpanel Group / PostHog group / GA user_prop) |
| Entity | `entity_id` nested under org |

- **Org Admin / Super Admin** → admin analytics panel filtered to their `organizationId` (server-enforced).  
- **Platform Admin** → same panel with org picker = All + each customer.  

Update `docs/PRODUCT_ANALYTICS_PLAN.md` §1.2 accordingly (done in tandem).

---

## 7. Security invariants

1. **No cross-org IDOR** — every `findById` checks resource `organizationId` (or entity→org) matches active org (or platform mode).  
2. **Platform actions always audit-logged** (who, which org, before/after).  
3. **Org Super Admin cannot escalate to Platform.**  
4. **Permission resolve is org-contextual** — caching `/me` must key by `activeOrganizationId`.  
5. **Fail closed** — missing membership ⇒ 403, not empty global data.  
6. Prefer **service-level** org checks (same lesson as soft-delete owner checks in CLAUDE.md).

---

## 8. Build order

1. Schema: `Organization`, `OrganizationMembership`, `Entity.organizationId`, `User.platformRole`.  
2. Auth resolve: active org + orgRole + platformRole on `/me`.  
3. Enforce org scope on one vertical (e.g. users + leave) as template; roll out.  
4. Org admin members UI.  
5. Platform org directory UI.  
6. Retire global Admin bypass; map Manut team to Platform Admin.  
7. Analytics identify/group by organization; platform all-org dashboard.

---

## 9. Open questions

1. Can one user belong to **multiple** customer orgs in v1, or one org only? (Model supports multi; UI can restrict.)  
2. Exact Manut team list for Platform Admin seed.  
3. Do Org Admins customize permission packs, or only the three fixed roles?  
4. Is `Entity` still required under every org (multi-country customers), or can small orgs be single-entity only?
