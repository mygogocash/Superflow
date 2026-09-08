import type { Express } from "express";

import { accountingRoutes } from "@/modules/accounting";
import { accountingCrmRoutes } from "@/modules/accounting-crm";
import { accountsRoutes } from "@/modules/accounts";
import { adminRoutes, adminUsageRoutes } from "@/modules/admin";
import { applicationsRoutes } from "@/modules/applications";
import { approvalChainsRoutes } from "@/modules/approval-chains";
import { ariaRoutes } from "@/modules/aria";
import { ariaTrainingRoutes } from "@/modules/aria-training";
import { articlesRoutes } from "@/modules/articles";
import { authRoutes } from "@/modules/auth";
import { benefitsRoutes } from "@/modules/benefits";
import { blogsRoutes } from "@/modules/blogs";
import { businessUnitsRoutes } from "@/modules/business-units";
import { careerRoutes } from "@/modules/career";
import { cashAdvanceRoutes } from "@/modules/cash-advance";
import { certificatesRoutes } from "@/modules/certificates";
import { companyDatesRoutes } from "@/modules/company-dates";
import { contactsRoutes } from "@/modules/contacts";
import { crmActivitiesRoutes } from "@/modules/crm-activities";
import { crmSettingsRoutes } from "@/modules/crm-settings";
import { crmReminderSettingsRoutes } from "@/modules/crm-shared/crm-settings.controller";
import { crmTasksRoutes } from "@/modules/crm-tasks";
import { cronRoutes } from "@/modules/cron";
import { dashboardRoutes } from "@/modules/dashboard";
import { dataroomRoutes } from "@/modules/dataroom";
import { dealsRoutes } from "@/modules/deals";
import { directoryRoutes } from "@/modules/directory";
import { docsRoutes } from "@/modules/docs";
import { exchangeRatesRoutes } from "@/modules/exchange-rates";
import { expensesRoutes } from "@/modules/expenses";
import { fundraisingEntitiesRoutes } from "@/modules/fundraising-entities";
import { helpdeskPublicRoutes, helpdeskRoutes } from "@/modules/helpdesk";
import { holidaysRoutes } from "@/modules/holidays";
import { hrmsRoutes } from "@/modules/hrms";
import { integrationsRoutes } from "@/modules/integrations";
import { investorAccountsRoutes } from "@/modules/investor-accounts";
import { investorActivitiesRoutes } from "@/modules/investor-activities";
import { investorContactsRoutes } from "@/modules/investor-contacts";
import { investorLeadsRoutes } from "@/modules/investor-leads";
import { investorPipelineStagesRoutes } from "@/modules/investor-pipeline-stages";
import { investorTagsRoutes } from "@/modules/investor-tags";
import { investorTasksRoutes } from "@/modules/investor-tasks";
import { investorTypesRoutes } from "@/modules/investor-types";
import { investorUpdatesRoutes } from "@/modules/investor-updates";
import { investorsRoutes } from "@/modules/investors";
import { itAccessRoutes } from "@/modules/it-access";
import { itBillingRoutes } from "@/modules/it-billing";
import { itCrmRoutes } from "@/modules/it-crm";
import { itOperationsRoutes } from "@/modules/it-operations";
import { leadSourcesRoutes } from "@/modules/lead-sources";
import { leadsRoutes } from "@/modules/leads";
import { learningRoutes } from "@/modules/learning";
import { leaveRoutes } from "@/modules/leave";
import { legalPublicRoutes, legalRoutes } from "@/modules/legal";
import { legalAnnouncementsRoutes } from "@/modules/legal-announcements";
import { legalCrmRoutes } from "@/modules/legal-crm";
import { lostReasonsRoutes } from "@/modules/lost-reasons";
import { marketingRoutes } from "@/modules/marketing";
import { marketingAnalyticsRoutes } from "@/modules/marketing-analytics";
import { isMarketingAnalyticsEnabled } from "@/modules/marketing-analytics/marketing.flags";
import { marketingCampaignsRoutes } from "@/modules/marketing-campaigns";
import { marketingRecapRoutes } from "@/modules/marketing-recap";
import { marketingReportsRoutes } from "@/modules/marketing-reports";
import { messagesRoutes } from "@/modules/messages";
import { newsRoutes } from "@/modules/news";
import { ninetyDayRoutes } from "@/modules/ninety-day";
import { officeRoutes } from "@/modules/office";
import { opportunitiesRoutes } from "@/modules/opportunities";
import { organizationsRoutes } from "@/modules/organizations";
import { partnersRoutes } from "@/modules/partners";
import { payrollRoutes } from "@/modules/payroll";
import { performanceRoutes } from "@/modules/performance";
import { policiesRoutes } from "@/modules/policies";
import { productCrmRoutes } from "@/modules/product-crm";
import {
  projectsRoutes,
  projectsWorkflowPublicRoutes,
} from "@/modules/projects";
import { proposalsRoutes } from "@/modules/proposals";
import { pushRoutes } from "@/modules/push";
import { qaCrmRoutes } from "@/modules/qa-crm";
import { revenueRoutes } from "@/modules/revenue";
import { rolesRoutes } from "@/modules/roles";
import { surveyRouter } from "@/modules/survey";
import { surveyFormsRouter } from "@/modules/survey-forms";
import { tableLayoutsRoutes } from "@/modules/table-layouts";
import { travelRoutes } from "@/modules/travel";
import { uploadsRoutes } from "@/modules/uploads";
import { usersRoutes } from "@/modules/users";
import { validatorMonitorRoutes } from "@/modules/validator-monitor";
import { vendorsRoutes } from "@/modules/vendors";
import { visaRoutes } from "@/modules/visa";
import { visaChecklistRoutes } from "@/modules/visa-checklist";
import { visaKbRoutes } from "@/modules/visa-kb";
import { voucherCrmRoutes } from "@/modules/voucher-crm";
import { wallRoutes } from "@/modules/wall";

export function registerModules(app: Express) {
  app.use("/api/cron", cronRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/organizations", organizationsRoutes);
  app.use("/api/admin/users", usersRoutes);
  app.use("/api/roles", rolesRoutes);
  app.use("/api/leave", leaveRoutes);
  app.use("/api/holidays", holidaysRoutes);
  app.use("/api/payroll", payrollRoutes);
  app.use("/api/accounting", accountingRoutes);
  app.use("/api/vendors", vendorsRoutes);
  app.use("/api/exchange-rates", exchangeRatesRoutes);
  app.use("/api/expenses", expensesRoutes);
  app.use("/api/wall", wallRoutes);
  app.use("/api/validator-monitor", validatorMonitorRoutes);
  app.use("/api/news", newsRoutes);
  app.use("/api/certificates", certificatesRoutes);
  app.use("/api/company-dates", companyDatesRoutes);
  app.use("/api/dashboard", dashboardRoutes);
  app.use("/api/messages", messagesRoutes);
  app.use("/api/aria", ariaRoutes);
  app.use("/api/aria-training", ariaTrainingRoutes);
  app.use("/api/integrations", integrationsRoutes);
  app.use("/api/investors", investorsRoutes);
  app.use("/api/investor/tasks", investorTasksRoutes);
  app.use("/api/investor/activities", investorActivitiesRoutes);
  app.use("/api/investor/leads", investorLeadsRoutes);
  app.use("/api/investor/accounts", investorAccountsRoutes);
  app.use("/api/investor/contacts", investorContactsRoutes);
  app.use("/api/investor/pipeline-stages", investorPipelineStagesRoutes);
  app.use("/api/investor/types", investorTypesRoutes);
  app.use("/api/investor/tags", investorTagsRoutes);
  app.use("/api/investor/entities", fundraisingEntitiesRoutes);
  app.use("/api/uploads", uploadsRoutes);
  app.use("/api/admin/usage", adminUsageRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/partners", partnersRoutes);
  // `/api/marketing` is the ORIGINAL module and is already in production —
  // it stays ungated.
  app.use("/api/marketing", marketingRoutes);

  // The Marketing Analytics family ships dark. Gating the mount (rather than
  // excluding these modules from every release) is what lets them travel to
  // `main` inert; a permission gate would not do it, because Admin bypasses
  // every permission check. Fail-closed: unset keeps them hidden.
  if (isMarketingAnalyticsEnabled()) {
    app.use("/api/marketing-analytics", marketingAnalyticsRoutes);
    app.use("/api/marketing-campaigns", marketingCampaignsRoutes);
    app.use("/api/marketing-recap", marketingRecapRoutes);
    app.use("/api/marketing-reports", marketingReportsRoutes);
  }
  app.use("/api/deals", dealsRoutes);
  app.use("/api/leads", leadsRoutes);
  app.use("/api/lead-sources", leadSourcesRoutes);
  app.use("/api/lost-reasons", lostReasonsRoutes);
  // Business units (Onewave / Onewave Revenue / ARIA …) — the Sales CRM's
  // admin-editable tag list. Its delete path still strips codes from the
  // PARKED revenue_* tables (see the retired-module note below).
  app.use("/api/business-units", businessUnitsRoutes);
  app.use("/api/accounts", accountsRoutes);
  app.use("/api/contacts", contactsRoutes);
  app.use("/api/opportunities", opportunitiesRoutes);
  app.use("/api/crm/activities", crmActivitiesRoutes);
  app.use("/api/crm/tasks", crmTasksRoutes);
  app.use("/api/crm/settings", crmSettingsRoutes);
  // /api/sales-revenue/* is GONE — the ARIA Revenue CRM was retired
  // 2026-08-26 and its deals migrated onto the Sales CRM board tagged
  // `aria`. Its `revenue_*` tables are parked (see CLAUDE.md), not dropped,
  // and business-units/revenue-rollup.repository.ts is the one remaining
  // code path that writes them.
  app.use("/api/project-workflow", projectsWorkflowPublicRoutes);
  app.use("/api/projects", projectsRoutes);
  app.use("/api/proposals", proposalsRoutes);
  // Project CRM approval chain configuration. Reads are open to Project CRM
  // readers; every write is system-admin only.
  app.use("/api/approval-chains", approvalChainsRoutes);
  // Web Push subscriptions. Every route acts on the caller's OWN devices, so
  // `authenticate` is the whole authorisation — there is no route here that can
  // address another user's device. The `/test` route inside is additionally
  // fenced off in production; see push.controller.ts.
  app.use("/api/push", pushRoutes);
  // Per-CRM reminder-recipient settings (parameterized; IT keeps its own).
  // Mounted AFTER the literal /api/crm/* routers above so activities / tasks /
  // settings never fall through to the :module param.
  app.use("/api/crm", crmReminderSettingsRoutes);
  app.use("/api/it-crm", itCrmRoutes);
  app.use("/api/it-operations", itOperationsRoutes);
  app.use("/api/it-billing", itBillingRoutes);
  app.use("/api/it-access", itAccessRoutes);
  app.use("/api/qa-crm", qaCrmRoutes);
  app.use("/api/accounting-crm", accountingCrmRoutes);
  app.use("/api/legal-crm", legalCrmRoutes);
  app.use("/api/product-crm", productCrmRoutes);
  app.use("/api/voucher-crm", voucherCrmRoutes);
  app.use("/api/hrms", hrmsRoutes);
  app.use("/api/helpdesk", helpdeskRoutes);
  app.use("/api/visa", visaRoutes);
  app.use("/api/visa-kb", visaKbRoutes);
  app.use("/api/visa-checklist", visaChecklistRoutes);
  app.use("/api/ninety-day-notifications", ninetyDayRoutes);
  app.use("/api/learning", learningRoutes);
  app.use("/api/office", officeRoutes);
  app.use("/api/policies", policiesRoutes);
  app.use("/api/benefits", benefitsRoutes);
  app.use("/api/blogs", blogsRoutes);
  app.use("/api/docs", docsRoutes);
  app.use("/api/articles", articlesRoutes);
  app.use("/api/revenue", revenueRoutes);
  app.use("/api/directory", directoryRoutes);
  app.use("/api/dataroom", dataroomRoutes);
  app.use("/api/investor-updates", investorUpdatesRoutes);
  app.use("/api/career", careerRoutes);
  app.use("/api/cash-advance", cashAdvanceRoutes);
  app.use("/api/applications", applicationsRoutes);
  app.use("/api/survey", surveyRouter);
  app.use("/api/survey-forms", surveyFormsRouter);
  app.use("/api/table-layouts", tableLayoutsRoutes);
  app.use("/api/travel", travelRoutes);
  app.use("/api/performance", performanceRoutes);
  app.use("/api/legal", legalRoutes);
  app.use("/api/legal-announcements", legalAnnouncementsRoutes);
  // Public token-auth signing routes — NO global auth middleware.
  app.use("/api/legal-public", legalPublicRoutes);
  // GitHub webhook receiver — HMAC-signed by the configured secret.
  app.use("/api/helpdesk-public", helpdeskPublicRoutes);
}
