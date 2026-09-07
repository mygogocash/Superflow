import { z } from "zod";

export const buildDatasetSchema = z.object({
  kind: z.enum(["sft", "dpo", "eval", "retrieval"]),
  until: z.string().datetime().optional(),
  requirePermission: z.string().min(1).max(100).optional(),
});

export const registerModelVersionSchema = z.object({
  name: z.string().min(1).max(120),
  baseModel: z.string().min(1).max(120),
  method: z.enum(["sft", "dpo", "prompt"]),
  datasetId: z.string().uuid().optional(),
  externalRef: z.string().max(300).optional(),
  notes: z.string().max(2000).optional(),
});

const metricMap = z.record(z.string(), z.number());

export const promoteModelVersionSchema = z.object({
  baseline: metricMap,
  candidate: metricMap,
  specs: z
    .record(
      z.string(),
      z.object({
        direction: z.enum(["higher_is_better", "lower_is_better"]),
        tolerance: z.number().optional(),
        bound: z.number().optional(),
      }),
    )
    .optional(),
});

export type BuildDatasetInput = z.infer<typeof buildDatasetSchema>;
export type RegisterModelVersionInput = z.infer<
  typeof registerModelVersionSchema
>;
export type PromoteModelVersionInput = z.infer<
  typeof promoteModelVersionSchema
>;
