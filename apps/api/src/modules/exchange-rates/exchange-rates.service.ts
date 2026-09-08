import { normaliseCurrencyCode } from "@nexora/utils";

import { prisma } from "@/infrastructure/database/prisma";

// PRD §11.5 follow-up — cross-currency aggregation. Reuses the existing
// `exchange_rates` table from the finance module. Rates store
// `1 baseCurrency = rate * currency` (e.g. USD → THB at 36.4); we
// invert when the source currency is the `baseCurrency` side and the
// target is the `currency` side.
//
// Lookup order: identity → direct → inverse → triangulated via a
// bridge currency. Finance keeps most rates anchored to USD, so a run
// that mixes THB / USD / INR would silently lose the INR slips from the
// headline total without triangulation.
//
// Date-effective: pass `asOf` to value a conversion at the rate in
// force on a given day (e.g. an expense's own date) — the most recent
// row with `effectiveDate <= asOf`. Without `asOf` the latest rate is
// used. If no row exists on/before `asOf` (the day predates any stored
// rate), we fall back to the latest available row so the conversion
// still happens rather than dropping the line.

export interface FxLookupResult {
  rate: number; // multiplier: amountInTo = amountInFrom * rate
  source: "direct" | "inverse" | "identity" | "triangulated" | "missing";
  /** When `source === "triangulated"`, the bridge currency we routed through. */
  bridge?: string;
}

// Currencies we try as a bridge when no direct / inverse rate is on
// file. USD first because finance keeps it as the canonical base;
// THB second so a Thailand-entity run can still convert when only entity-
// local quotes are stored.
const BRIDGE_CURRENCIES = ["USD", "THB", "EUR"] as const;

function asOfKey(asOf?: Date): string {
  return asOf ? asOf.toISOString().slice(0, 10) : "latest";
}

export class ExchangeRateService {
  // In-memory cache keyed by `${from}-${to}-${asOf}`. A request converts
  // many lines but converges on a small set of (pair, date) combos, so
  // caching avoids repeated Prisma round-trips. Cache lives per-request
  // — instantiate via the exported factory and discard.
  private cache = new Map<string, FxLookupResult>();

  async resolveRate(
    from: string,
    to: string,
    asOf?: Date,
  ): Promise<FxLookupResult> {
    /*
     * Normalised here rather than at each caller, because this is the one point
     * every conversion passes through. Expense lines hold whatever was typed, and
     * no provider can quote a string that is not an ISO code — so a line filed as
     * "RMB" or "₹" resolved to nothing and silently dropped out of the THB total.
     *
     * Only unambiguous aliases resolve. "¥" stays unresolved on purpose: it is
     * both CNY and JPY, and guessing would misprice by roughly twenty times.
     */
    return this.resolveRateInternal(
      normaliseCurrencyCode(from),
      normaliseCurrencyCode(to),
      asOf,
      new Set(),
    );
  }

  private async resolveRateInternal(
    from: string,
    to: string,
    asOf: Date | undefined,
    visited: Set<string>,
  ): Promise<FxLookupResult> {
    const key = `${from}-${to}-${asOfKey(asOf)}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (visited.has(key)) {
      // Prevent infinite recursion when a bridge attempt loops back
      // onto the same pair (shouldn't happen with the small static
      // bridge list, but guard anyway).
      return { rate: 0, source: "missing" };
    }
    visited.add(key);

    if (from === to) {
      const result: FxLookupResult = { rate: 1, source: "identity" };
      this.cache.set(key, result);
      return result;
    }

    // Direct path: `1 from = X to`.
    const direct = await this.findRate(from, to, asOf);
    if (direct !== null) {
      const result: FxLookupResult = { rate: direct, source: "direct" };
      this.cache.set(key, result);
      return result;
    }

    // Inverse path: `1 to = X from` → `1 from = (1/X) to`.
    const inverse = await this.findRate(to, from, asOf);
    if (inverse !== null) {
      const result: FxLookupResult = { rate: 1 / inverse, source: "inverse" };
      this.cache.set(key, result);
      return result;
    }

    // Triangulate via a bridge currency. `rate(from→to) =
    // rate(from→bridge) * rate(bridge→to)`. Try every configured bridge
    // in order, taking the first pair that resolves on both legs (each
    // leg via direct OR inverse — never another bridge).
    for (const bridge of BRIDGE_CURRENCIES) {
      if (bridge === from || bridge === to) continue;
      const leg1 = await this.resolveDirectOrInverse(from, bridge, asOf);
      if (leg1 === null) continue;
      const leg2 = await this.resolveDirectOrInverse(bridge, to, asOf);
      if (leg2 === null) continue;
      const result: FxLookupResult = {
        rate: leg1 * leg2,
        source: "triangulated",
        bridge,
      };
      this.cache.set(key, result);
      return result;
    }

    const missing: FxLookupResult = { rate: 0, source: "missing" };
    this.cache.set(key, missing);
    return missing;
  }

  // Single-hop lookup used by the triangulation pass. Returns null when
  // neither direct nor inverse row exists.
  private async resolveDirectOrInverse(
    from: string,
    to: string,
    asOf: Date | undefined,
  ): Promise<number | null> {
    if (from === to) return 1;
    const direct = await this.findRate(from, to, asOf);
    if (direct !== null) return direct;
    const inverse = await this.findRate(to, from, asOf);
    if (inverse !== null) return 1 / inverse;
    return null;
  }

  // Rate for `1 baseCurrency = X currency`, valued on/before `asOf` when
  // given (most recent such row), else the latest. Falls back to the
  // latest row when nothing exists on/before `asOf`.
  private async findRate(
    baseCurrency: string,
    currency: string,
    asOf?: Date,
  ): Promise<number | null> {
    if (asOf) {
      const dated = await prisma.exchangeRate.findFirst({
        where: { baseCurrency, currency, effectiveDate: { lte: asOf } },
        orderBy: { effectiveDate: "desc" },
        select: { rate: true },
      });
      if (dated) return Number(dated.rate);
    }
    const latest = await prisma.exchangeRate.findFirst({
      where: { baseCurrency, currency },
      orderBy: { effectiveDate: "desc" },
      select: { rate: true },
    });
    return latest ? Number(latest.rate) : null;
  }
}

export function createExchangeRateService(): ExchangeRateService {
  return new ExchangeRateService();
}
