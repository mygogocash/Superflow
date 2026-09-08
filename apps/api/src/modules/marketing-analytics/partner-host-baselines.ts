/**
 * Admin-editable host-app baselines per telco partner.
 *
 * "Host MAU / Host DAU" are the TELCO'S OWN app figures — Telkomsel's app having
 * 25M MAU — used purely as a denominator to size OneWave's traffic against. They
 * are not measured by us and are not returned by the BNII Analytics API; they
 * were hand-entered from public figures into `bnii-partners.ts`.
 *
 * Two of the nine partners (Ryze-Banglalink and Robi) shipped as null because no
 * public figure was found, which renders as "—" on the partner cards. This
 * module lets an admin supply those numbers — and correct any of the others as
 * operators publish updated figures — without a code change and a deploy.
 *
 * STORAGE. One SystemSetting row holding a JSON map keyed by partner slug,
 * following the `payslip.company` precedent: no migration, no seed, and the
 * hardcoded constants stay the fallback so every environment keeps rendering
 * today's values until someone overrides them.
 *
 * NULL IS A REAL VALUE HERE. An admin can deliberately clear a baseline back to
 * "unknown": a stored `null` is an override meaning "no public figure exists",
 * which is NOT the same as the slug being absent from the map (meaning "no
 * override — use the constant"). Collapsing the two would make it impossible to
 * un-set a value once entered, and would quietly resurrect a stale constant.
 */

import type { Prisma } from "@nexora/database";

import { BadRequestException } from "@/common/exceptions/http-exception";
import { prisma } from "@/infrastructure/database/prisma";

/**
 * Prisma's InputJsonValue does not accept a typed record even structurally, so
 * the map is widened at the boundary. Documented in the header as the same trap
 * the payslip company block hit.
 */
const toJson = (m: HostBaselineMap): Prisma.InputJsonValue =>
  m as unknown as Prisma.InputJsonValue;

export const PARTNER_HOST_BASELINES_KEY = "marketing.partner_host_baselines";

export interface HostBaseline {
  hostDau: number | null;
  hostMau: number | null;
  hostSessionSec: number | null;
}

/** slug → override. A slug present with all-null means "explicitly unknown". */
export type HostBaselineMap = Record<string, HostBaseline>;

/**
 * Coerce one stored field. Rejects negatives and non-finite values rather than
 * storing them — a negative denominator would render a nonsensical benchmark
 * bar rather than fail, so it is refused at the boundary.
 */
function readNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v);
}

function readBaseline(v: unknown): HostBaseline | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    hostDau: readNumber(o.hostDau),
    hostMau: readNumber(o.hostMau),
    hostSessionSec: readNumber(o.hostSessionSec),
  };
}

/**
 * Every stored override, type-guarded field by field. A malformed row yields an
 * empty map rather than throwing: a bad admin edit must not take down the
 * partner list, which is the page's primary content.
 */
export async function getHostBaselineOverrides(): Promise<HostBaselineMap> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: PARTNER_HOST_BASELINES_KEY },
  });
  const value = row?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const out: HostBaselineMap = {};
  for (const [slug, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed = readBaseline(raw);
    if (parsed) out[slug] = parsed;
  }
  return out;
}

/**
 * Apply overrides on top of the registry values.
 *
 * The override wins whenever the slug is present — including when its fields are
 * null, which is how an admin records "this figure is genuinely unpublished".
 */
export function applyHostBaseline<
  T extends {
    hostDau: number | null;
    hostMau: number | null;
    hostSessionSec: number | null;
  },
>(partner: T, slug: string, overrides: HostBaselineMap): T {
  const o = overrides[slug];
  if (!o) return partner;
  return {
    ...partner,
    hostDau: o.hostDau,
    hostMau: o.hostMau,
    hostSessionSec: o.hostSessionSec,
  };
}

/**
 * Upsert one partner's baseline. Writes an INLINE object literal for `value` —
 * a typed variable trips Prisma's InputJsonValue (the trap the payslip company
 * block already documents).
 */
export async function setHostBaseline(
  slug: string,
  baseline: HostBaseline,
): Promise<HostBaselineMap> {
  // `slug` becomes an object key below; reject the prototype-pollution keys so
  // a crafted slug cannot poison Object.prototype (CodeQL js/remote-property-injection).
  if (slug === "__proto__" || slug === "constructor" || slug === "prototype") {
    throw new BadRequestException("Invalid partner slug");
  }
  const current = await getHostBaselineOverrides();
  const next: HostBaselineMap = {
    ...current,
    [slug]: {
      hostDau: readNumber(baseline.hostDau),
      hostMau: readNumber(baseline.hostMau),
      hostSessionSec: readNumber(baseline.hostSessionSec),
    },
  };
  await prisma.systemSetting.upsert({
    where: { key: PARTNER_HOST_BASELINES_KEY },
    create: { key: PARTNER_HOST_BASELINES_KEY, value: toJson(next) },
    update: { value: toJson(next) },
  });
  return next;
}

/**
 * Drop a partner's override entirely, restoring the hardcoded constant. NOT the
 * same as storing all-null, which pins the value to "unknown".
 */
export async function clearHostBaseline(
  slug: string,
): Promise<HostBaselineMap> {
  const current = await getHostBaselineOverrides();
  if (!(slug in current)) return current;
  const next = { ...current };
  delete next[slug];
  await prisma.systemSetting.upsert({
    where: { key: PARTNER_HOST_BASELINES_KEY },
    create: { key: PARTNER_HOST_BASELINES_KEY, value: toJson(next) },
    update: { value: toJson(next) },
  });
  return next;
}
