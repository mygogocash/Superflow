import { Hono } from "hono";
import type { AppEnv } from "../lib/context";
import { health } from "./health";
import { me } from "./me";
import { users } from "./users";
import { roles } from "./roles";
import { dashboard } from "./dashboard";
import { wall } from "./wall";
import { news } from "./news";
import { companyDates } from "./company-dates";
import { holidays } from "./holidays";
import { articles } from "./articles";
import { blogs } from "./blogs";
import { policies } from "./policies";
import { benefits } from "./benefits";
import { applications } from "./applications";
import { career } from "./career";
import { learning } from "./learning";
import { certificates } from "./certificates";
import { performance } from "./performance";
import { docs } from "./docs";
import { office } from "./office";
import { organizations } from "./organizations";
import { survey } from "./survey";
import { surveyForms } from "./survey-forms";
import { visaChecklist } from "./visa-checklist";
import { visaKb } from "./visa-kb";
import { ninetyDayNotifications } from "./ninety-day-notifications";
import { vendors } from "./vendors";
import { exchangeRates } from "./exchange-rates";
import { cashAdvance } from "./cash-advance";
import { expenses } from "./expenses";
import { leave } from "./leave";
import { travel } from "./travel";
import { approvalChains } from "./approval-chains";
import { visa } from "./visa";
import { accounts } from "./accounts";
import { payroll } from "./payroll";
import { accounting } from "./accounting";
import { hrms } from "./hrms";
import { projects } from "./projects";
import { helpdesk } from "./helpdesk";
import { leadSources } from "./lead-sources";
import { lostReasons } from "./lost-reasons";
import { crmSettings } from "./crm-settings";
import { contacts } from "./contacts";
import { leads } from "./leads";
import { opportunities } from "./opportunities";
import { crmActivities } from "./crm-activities";
import { crmTasks } from "./crm-tasks";
import { deals } from "./deals";
import { legalAnnouncements } from "./legal-announcements";
import { legal } from "./legal";
import { voucherCrm } from "./voucher-crm";
import { productCrm } from "./product-crm";
import { legalCrm } from "./legal-crm";
import { accountingCrm } from "./accounting-crm";
import { qaCrm } from "./qa-crm";
import { itAccess } from "./it-access";
import { itBilling } from "./it-billing";
import { itOperations } from "./it-operations";
import { itCrm } from "./it-crm";
import { proposals } from "./proposals";
import { validatorMonitor } from "./validator-monitor";
import { businessUnits } from "./business-units";
import { investors } from "./investors";
import { investorLeads } from "./investor-leads";
import { investorAccounts } from "./investor-accounts";
import { investorContacts } from "./investor-contacts";
import { investorTasks } from "./investor-tasks";
import { investorActivities } from "./investor-activities";
import { investorTypes } from "./investor-types";
import { investorPipelineStages } from "./investor-pipeline-stages";
import { fundraisingEntities } from "./fundraising-entities";
import { investorUpdates } from "./investor-updates";
import { dataroom } from "./dataroom";
import { partners } from "./partners";
import { directory } from "./directory";
import { tableLayouts } from "./table-layouts";
import { revenue } from "./revenue";
import { adminUsage } from "./admin-usage";
import { admin } from "./admin";
import { integrations } from "./integrations";
import { cron } from "./cron";
import { aria } from "./aria";
import { marketingAnalytics } from "./marketing-analytics";
import { marketingReports } from "./marketing-reports";
import { marketingCampaigns } from "./marketing-campaigns";
import { marketingRecap } from "./marketing-recap";
import { marketing } from "./marketing";
import { push } from "./push";
import { messages } from "./messages";
import { uploads } from "./uploads";
import { handbook } from "./handbook";

/**
 * All `/api/*` routes. Modules are mounted here wave by wave; each module file
 * exports a Hono sub-app so `hc<typeof leave>("/api/leave")` gives typed RPC
 * per module (Hono's recommendation for large route trees).
 *
 * Better Auth owns `/api/auth/*` (sign-in, magic-link, reset, session). Our
 * `/api/auth/me` is registered BEFORE the catch-all handler so it wins.
 */
export const api = new Hono<AppEnv>()
  .route("/health", health)
  .route("/auth/me", me)
  .route("/users", users)
  .route("/roles", roles)
  .route("/dashboard", dashboard)
  .route("/wall", wall)
  .route("/news", news)
  .route("/company-dates", companyDates)
  .route("/holidays", holidays)
  .route("/articles", articles)
  .route("/blogs", blogs)
  .route("/policies", policies)
  .route("/benefits", benefits)
  .route("/applications", applications)
  .route("/career", career)
  .route("/learning", learning)
  .route("/certificates", certificates)
  .route("/performance", performance)
  .route("/docs", docs)
  .route("/office", office)
  .route("/organizations", organizations)
  .route("/survey", survey)
  .route("/survey-forms", surveyForms)
  .route("/visa-checklist", visaChecklist)
  .route("/visa-kb", visaKb)
  .route("/ninety-day-notifications", ninetyDayNotifications)
  .route("/vendors", vendors)
  .route("/exchange-rates", exchangeRates)
  .route("/cash-advance", cashAdvance)
  .route("/expenses", expenses)
  .route("/handbook", handbook)
  .route("/leave", leave)
  .route("/travel", travel)
  .route("/approval-chains", approvalChains)
  .route("/visa", visa)
  .route("/accounts", accounts)
  .route("/payroll", payroll)
  .route("/accounting", accounting)
  .route("/hrms", hrms)
  .route("/projects", projects)
  .route("/helpdesk", helpdesk)
  .route("/lead-sources", leadSources)
  .route("/lost-reasons", lostReasons)
  .route("/contacts", contacts)
  .route("/leads", leads)
  .route("/opportunities", opportunities)
  .route("/crm/activities", crmActivities)
  .route("/crm/tasks", crmTasks)
  .route("/crm/settings", crmSettings)
  .route("/deals", deals)
  .route("/legal-announcements", legalAnnouncements)
  .route("/legal", legal)
  .route("/voucher-crm", voucherCrm)
  .route("/product-crm", productCrm)
  .route("/legal-crm", legalCrm)
  .route("/accounting-crm", accountingCrm)
  .route("/qa-crm", qaCrm)
  .route("/it-access", itAccess)
  .route("/it-billing", itBilling)
  .route("/it-operations", itOperations)
  .route("/it-crm", itCrm)
  .route("/proposals", proposals)
  .route("/validator-monitor", validatorMonitor)
  .route("/business-units", businessUnits)
  .route("/partners", partners)
  .route("/investors", investors)
  .route("/investor/leads", investorLeads)
  .route("/investor/accounts", investorAccounts)
  .route("/investor/contacts", investorContacts)
  .route("/investor/tasks", investorTasks)
  .route("/investor/activities", investorActivities)
  .route("/investor/types", investorTypes)
  .route("/investor/pipeline-stages", investorPipelineStages)
  .route("/investor/entities", fundraisingEntities)
  .route("/investor-updates", investorUpdates)
  .route("/uploads", uploads)
  .route("/messages", messages)
  .route("/push", push)
  .route("/marketing", marketing)
  .route("/marketing-recap", marketingRecap)
  .route("/marketing-campaigns", marketingCampaigns)
  .route("/marketing-reports", marketingReports)
  .route("/marketing-analytics", marketingAnalytics)
  .route("/aria", aria)
  .route("/directory", directory)
  .route("/table-layouts", tableLayouts)
  .route("/revenue", revenue)
  .route("/admin/usage", adminUsage)
  .route("/admin", admin)
  .route("/integrations", integrations)
  .route("/cron", cron)
  .route("/dataroom", dataroom)
  .on(["GET", "POST"], "/auth/*", (c) => c.var.auth.handler(c.req.raw));

export type ApiType = typeof api;
