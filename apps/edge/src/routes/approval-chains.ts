import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  chainReorderSchema,
  chainScopeParamSchema,
  chainStepCreateSchema,
  chainStepUpdateSchema,
  chainUpdateSchema,
} from "@nexora/contracts/modules/approval-chains/chain.validation";
import type { ChainScope } from "@nexora/contracts/modules/approval-chains/chain.types";
import { chainService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requireSystemAdmin } from "../middleware/rbac";

// Approval-chain config is admin surface (approver identities / step order).
// projects:read is on every employee — do not leak chain layout on that gate.
export const approvalChains = new Hono<AppEnv>()
  .get("/", requireSystemAdmin, async (c) => {
    const data = await chainService.listChains(c.var.db);
    return c.json({ data });
  })
  .get("/:scope", requireSystemAdmin, async (c) => {
    const { scope } = chainScopeParamSchema.parse({ scope: c.req.param("scope") });
    const data = await chainService.getChain(c.var.db, scope as ChainScope);
    if (!data) {
      return c.json({ message: "No chain configured for that scope" }, 404);
    }
    return c.json({ data });
  })
  .put("/:scope", requireSystemAdmin, zValidator("json", chainUpdateSchema), async (c) => {
    const { scope } = chainScopeParamSchema.parse({ scope: c.req.param("scope") });
    const input = c.req.valid("json");
    await chainService.updateChain(c.var.db, scope as ChainScope, input);
    const data = await chainService.getChain(c.var.db, scope as ChainScope);
    return c.json({ data });
  })
  .post("/:scope/steps", requireSystemAdmin, zValidator("json", chainStepCreateSchema), async (c) => {
    const { scope } = chainScopeParamSchema.parse({ scope: c.req.param("scope") });
    const input = c.req.valid("json");
    await chainService.addStep(c.var.db, scope as ChainScope, {
      name: input.name,
      description: input.description ?? null,
      approverUserId: input.approverUserId ?? null,
    });
    const data = await chainService.getChain(c.var.db, scope as ChainScope);
    return c.json({ data }, 201);
  })
  .put("/:scope/steps/reorder", requireSystemAdmin, zValidator("json", chainReorderSchema), async (c) => {
    const { scope } = chainScopeParamSchema.parse({ scope: c.req.param("scope") });
    const input = c.req.valid("json");
    await chainService.reorderSteps(c.var.db, scope as ChainScope, input.orderedIds);
    const data = await chainService.getChain(c.var.db, scope as ChainScope);
    return c.json({ data });
  })
  .put("/:scope/steps/:stepId", requireSystemAdmin, zValidator("json", chainStepUpdateSchema), async (c) => {
    const { scope } = chainScopeParamSchema.parse({ scope: c.req.param("scope") });
    const input = c.req.valid("json");
    await chainService.updateStep(c.var.db, c.req.param("stepId"), input);
    const data = await chainService.getChain(c.var.db, scope as ChainScope);
    return c.json({ data });
  })
  .delete("/:scope/steps/:stepId", requireSystemAdmin, async (c) => {
    const { scope } = chainScopeParamSchema.parse({ scope: c.req.param("scope") });
    await chainService.removeStep(c.var.db, c.req.param("stepId"));
    const data = await chainService.getChain(c.var.db, scope as ChainScope);
    return c.json({ data });
  });
