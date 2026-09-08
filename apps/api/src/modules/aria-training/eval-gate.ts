// Phase 3/4 — the promotion gate. A candidate model/prompt version may only be
// promoted if it does not regress against the baseline on the tracked metrics.
// Pure + deterministic so it is unit-tested and reused by the API and CI.

/** Direction of "good" for a metric. */
export type MetricDirection = "higher_is_better" | "lower_is_better";

export interface MetricSpec {
  direction: MetricDirection;
  /** Allowed slippage vs baseline before it counts as a regression. */
  tolerance?: number;
  /** Absolute floor (higher_is_better) or ceiling (lower_is_better). */
  bound?: number;
}

export interface GateRegression {
  metric: string;
  baseline: number;
  candidate: number;
  reason: string;
}

export interface GateResult {
  pass: boolean;
  regressions: GateRegression[];
}

/**
 * Compare candidate metrics against a baseline under per-metric specs. A metric
 * regresses if the candidate moves the wrong way by more than `tolerance`, or
 * breaches an absolute `bound`. Metrics present in `specs` but missing from
 * either side are reported as a regression (you can't prove no-regression on a
 * metric you didn't measure).
 */
export function evaluateGate(
  baseline: Record<string, number>,
  candidate: Record<string, number>,
  specs: Record<string, MetricSpec>,
): GateResult {
  const regressions: GateRegression[] = [];

  for (const [metric, spec] of Object.entries(specs)) {
    const b = baseline[metric];
    const c = candidate[metric];
    if (typeof b !== "number" || typeof c !== "number") {
      regressions.push({
        metric,
        baseline: b ?? NaN,
        candidate: c ?? NaN,
        reason: "metric missing from baseline or candidate",
      });
      continue;
    }
    const tol = spec.tolerance ?? 0;

    if (spec.direction === "higher_is_better") {
      if (c < b - tol) {
        regressions.push({
          metric,
          baseline: b,
          candidate: c,
          reason: `dropped ${(b - c).toFixed(4)} (> tolerance ${tol})`,
        });
      }
      if (spec.bound !== undefined && c < spec.bound) {
        regressions.push({
          metric,
          baseline: b,
          candidate: c,
          reason: `below floor ${spec.bound}`,
        });
      }
    } else {
      if (c > b + tol) {
        regressions.push({
          metric,
          baseline: b,
          candidate: c,
          reason: `rose ${(c - b).toFixed(4)} (> tolerance ${tol})`,
        });
      }
      if (spec.bound !== undefined && c > spec.bound) {
        regressions.push({
          metric,
          baseline: b,
          candidate: c,
          reason: `above ceiling ${spec.bound}`,
        });
      }
    }
  }

  return { pass: regressions.length === 0, regressions };
}

/** Default gate for ARIA: retrieval hit-rate must not regress, latency/error must not balloon. */
export const DEFAULT_ARIA_GATE_SPECS: Record<string, MetricSpec> = {
  hitRate: { direction: "higher_is_better", tolerance: 0.02, bound: 0.6 },
  errorRate: { direction: "lower_is_better", tolerance: 0.01 },
  p95LatencyMs: { direction: "lower_is_better", tolerance: 500 },
};
