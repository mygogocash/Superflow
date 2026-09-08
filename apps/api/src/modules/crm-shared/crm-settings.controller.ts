import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";

import { PERMISSIONS } from "@/common/constants/permissions";
import { NotFoundException } from "@/common/exceptions/http-exception";
import {
  authenticate,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import type { CrmModule } from "@/modules/crm-shared/crm-modules";
import {
  getCrmReminderRecipients,
  setCrmReminderRecipients,
} from "@/modules/crm-shared/crm-recipients";

// Admin-editable deadline-reminder / update-notification recipient lists,
// one SystemSetting row per CRM (see crm-recipients.ts). IT keeps its own
// /it-crm/reminder-settings routes (shipped with #896/#899); every other CRM
// reads/writes through these parameterized routes so a new CRM is one map
// entry, not a new controller.
//
// Org-wide reminder recipient lists: require read-all/manage (not bare module
// read or projects:read). Write stays manage-only.
const MODULE_PERMS: Partial<
  Record<CrmModule, { read: string[]; write: string[] }>
> = {
  general: {
    read: [PERMISSIONS.PROJECTS_READ_ALL, PERMISSIONS.PROJECTS_MANAGE],
    write: [PERMISSIONS.PROJECTS_MANAGE],
  },
  hr: {
    read: [
      PERMISSIONS.HR_CRM_READ_ALL,
      PERMISSIONS.HR_CRM_MANAGE,
      PERMISSIONS.PROJECTS_READ_ALL,
      PERMISSIONS.PROJECTS_MANAGE,
    ],
    write: [PERMISSIONS.HR_CRM_MANAGE, PERMISSIONS.PROJECTS_MANAGE],
  },
  legal: {
    read: [
      PERMISSIONS.LEGAL_CRM_READ_ALL,
      PERMISSIONS.LEGAL_CRM_MANAGE,
      PERMISSIONS.PROJECTS_READ_ALL,
      PERMISSIONS.PROJECTS_MANAGE,
    ],
    write: [PERMISSIONS.LEGAL_CRM_MANAGE, PERMISSIONS.PROJECTS_MANAGE],
  },
  accounting: {
    read: [
      PERMISSIONS.ACCOUNTING_CRM_READ_ALL,
      PERMISSIONS.ACCOUNTING_CRM_MANAGE,
      PERMISSIONS.PROJECTS_READ_ALL,
      PERMISSIONS.PROJECTS_MANAGE,
    ],
    write: [PERMISSIONS.ACCOUNTING_CRM_MANAGE, PERMISSIONS.PROJECTS_MANAGE],
  },
  product: {
    read: [
      PERMISSIONS.PRODUCT_CRM_READ_ALL,
      PERMISSIONS.PRODUCT_CRM_MANAGE,
      PERMISSIONS.PROJECTS_READ_ALL,
      PERMISSIONS.PROJECTS_MANAGE,
    ],
    write: [PERMISSIONS.PRODUCT_CRM_MANAGE, PERMISSIONS.PROJECTS_MANAGE],
  },
  qa: {
    read: [
      PERMISSIONS.QA_CRM_READ_ALL,
      PERMISSIONS.QA_CRM_MANAGE,
      PERMISSIONS.PROJECTS_READ_ALL,
      PERMISSIONS.PROJECTS_MANAGE,
    ],
    write: [PERMISSIONS.QA_CRM_MANAGE, PERMISSIONS.PROJECTS_MANAGE],
  },
  sales: {
    // crm:read is on every employee — reminder recipient lists are settings.
    read: [PERMISSIONS.CRM_SETTINGS_MANAGE],
    write: [PERMISSIONS.CRM_SETTINGS_MANAGE],
  },
};

const recipientsSchema = z.object({
  recipients: z.array(z.string().trim().email()).max(50),
});

// Resolve the :module param to a known CRM and gate on its read/write perms.
// 404 (not 403) for an unknown module — the route space simply doesn't exist.
function gate(kind: "read" | "write") {
  return (req: Request, res: Response, next: NextFunction) => {
    const perms = MODULE_PERMS[req.params.module as CrmModule];
    if (!perms) return next(new NotFoundException("Unknown CRM module"));
    return requirePermission(...perms[kind])(req, res, next);
  };
}

const router = Router();
router.use(authenticate, requireActive);

router.get(
  "/:module/reminder-settings",
  gate("read"),
  asyncHandler(async (req, res) => {
    const data = await getCrmReminderRecipients(req.params.module as CrmModule);
    res.json({ data });
  }),
);

router.put(
  "/:module/reminder-settings",
  gate("write"),
  asyncHandler(async (req, res) => {
    const input = recipientsSchema.parse(req.body);
    const data = await setCrmReminderRecipients(
      req.params.module as CrmModule,
      input,
    );
    res.json({ data });
  }),
);

export { router as crmReminderSettingsRoutes };
