import {
  BadRequestException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { logger } from "@/common/utils/logger";
import { ariaTrainingRepository } from "@/modules/aria-training/aria-training.repository";
import {
  buildDatasetRows,
  datasetChecksum,
  type DatasetKind,
  toJsonl,
} from "@/modules/aria-training/dataset-format";
import {
  DEFAULT_ARIA_GATE_SPECS,
  evaluateGate,
  type MetricSpec,
} from "@/modules/aria-training/eval-gate";

// Traces are eligible for redaction after this many days (fail-safe default).
// Overridable so a stricter environment can shrink the raw-PII window.
const DEFAULT_REDACT_AFTER_DAYS = 7;

function redactAfterDays(): number {
  const raw = Number(process.env.ARIA_TRACE_REDACT_AFTER_DAYS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_REDACT_AFTER_DAYS;
}

export const ariaTrainingService = {
  // ── Phase 2: redaction cron ─────────────────────────────────────
  async runTraceRedaction() {
    const days = redactAfterDays();
    const redacted = await ariaTrainingRepository.redactPendingTraces(days);
    logger.info("ARIA trace redaction run", { redacted, retentionDays: days });
    return { data: { redacted, retentionDays: days } };
  },

  // ── Phase 2: build a versioned dataset ──────────────────────────
  async buildDataset(input: {
    kind: DatasetKind;
    until?: string;
    requirePermission?: string;
    createdById: string | null;
  }) {
    // Freeze the upper bound so the build is reproducible on re-export.
    const until = input.until ? new Date(input.until) : new Date();
    if (Number.isNaN(until.getTime())) {
      throw new BadRequestException("`until` must be a valid ISO date");
    }

    const traces = await ariaTrainingRepository.fetchRedactedTracesForDataset({
      until,
      requirePermission: input.requirePermission,
    });
    const rows = buildDatasetRows(input.kind, traces);
    const checksum = datasetChecksum(rows);
    const version = await ariaTrainingRepository.nextDatasetVersion(input.kind);

    const filters = {
      until: until.toISOString(),
      requirePermission: input.requirePermission ?? null,
    };
    const stats = {
      sourceTraces: traces.length,
      rowCount: rows.length,
      ratedUp: traces.filter((t) => t.rating === "up").length,
      ratedDown: traces.filter((t) => t.rating === "down").length,
    };

    const dataset = await ariaTrainingRepository.createDataset({
      kind: input.kind,
      version,
      rowCount: rows.length,
      filters,
      stats,
      checksum,
      createdById: input.createdById,
    });

    return { dataset, rowCount: rows.length, jsonl: toJsonl(rows) };
  },

  async listDatasets(kind?: string) {
    return { data: await ariaTrainingRepository.listDatasets(kind) };
  },

  /**
   * Re-export a recorded dataset by rebuilding from the frozen filters. Because
   * datasets only include already-redacted traces up to a frozen `until`, the
   * rebuild is deterministic; `drifted` is true only if the recorded checksum
   * no longer matches (which would signal an unexpected data mutation).
   */
  async exportDataset(id: string) {
    const dataset = await ariaTrainingRepository.getDataset(id);
    if (!dataset) throw new NotFoundException("Dataset not found");

    const filters = (dataset.filters ?? {}) as {
      until?: string;
      requirePermission?: string | null;
    };
    const until = filters.until ? new Date(filters.until) : new Date();
    const traces = await ariaTrainingRepository.fetchRedactedTracesForDataset({
      until,
      requirePermission: filters.requirePermission ?? undefined,
    });
    const rows = buildDatasetRows(dataset.kind as DatasetKind, traces);
    const checksum = datasetChecksum(rows);

    return {
      dataset,
      drifted: checksum !== dataset.checksum,
      jsonl: toJsonl(rows),
    };
  },

  // ── Phase 4: model-version registry + promotion gate ────────────
  async registerModelVersion(input: {
    name: string;
    baseModel: string;
    method: string;
    datasetId?: string;
    externalRef?: string;
    notes?: string;
    createdById: string | null;
  }) {
    if (input.datasetId) {
      const ds = await ariaTrainingRepository.getDataset(input.datasetId);
      if (!ds) throw new BadRequestException("datasetId does not exist");
    }
    const version = await ariaTrainingRepository.createModelVersion({
      name: input.name,
      baseModel: input.baseModel,
      method: input.method,
      datasetId: input.datasetId ?? null,
      externalRef: input.externalRef ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById,
    });
    return { data: version };
  },

  async listModelVersions(status?: string) {
    return { data: await ariaTrainingRepository.listModelVersions(status) };
  },

  /**
   * Run the promotion gate for a candidate version. Metrics come from an
   * external eval run; the gate decides promote vs reject and records the
   * outcome. Promotion is blocked on any regression (see evaluateGate).
   */
  async promoteModelVersion(
    id: string,
    input: {
      baseline: Record<string, number>;
      candidate: Record<string, number>;
      specs?: Record<string, MetricSpec>;
    },
  ) {
    const version = await ariaTrainingRepository.getModelVersion(id);
    if (!version) throw new NotFoundException("Model version not found");

    const specs = input.specs ?? DEFAULT_ARIA_GATE_SPECS;
    const gate = evaluateGate(input.baseline, input.candidate, specs);
    const status = gate.pass ? "promoted" : "rejected";
    const evalSummary = {
      baseline: input.baseline,
      candidate: input.candidate,
      pass: gate.pass,
      regressions: gate.regressions,
      evaluatedAt: new Date().toISOString(),
    };

    const updated = await ariaTrainingRepository.updateModelVersionStatus(
      id,
      status,
      evalSummary,
      gate.pass ? new Date() : null,
    );
    return { data: { version: updated, gate } };
  },

  // ── Phase 5: monitoring read-model ──────────────────────────────
  async metrics(sinceDays: number) {
    return { data: await ariaTrainingRepository.trainingMetrics(sinceDays) };
  },
};
