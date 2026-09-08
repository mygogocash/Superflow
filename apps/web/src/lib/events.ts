"use client";

import { tracking } from "@/lib/tracking";

/**
 * Central registry of every event name + a typed wrapper per event.
 *
 * Generated from .telemetry/tracking-plan.yaml. Every track call in the web
 * codebase MUST go through one of these wrappers — no raw event-name strings.
 *
 * Server-only events (approvals, payroll runs, errors, snapshot sync) live in
 * apps/api/src/lib/events.ts. Events shared by both surfaces are listed here
 * for the constant value — call sites still pick the surface.
 */

export const EVENTS = {
  // Lifecycle
  SESSION_STARTED: "session.started",
  SESSION_ENDED: "session.ended",
  USER_CREATED: "user.created",
  USER_DEACTIVATED: "user.deactivated",

  // Navigation
  MODULE_VIEWED: "module.viewed",
  SEARCH_PERFORMED: "search.performed",

  // Leave
  LEAVE_REQUEST_STARTED: "leave_request.started",
  LEAVE_REQUEST_SUBMITTED: "leave_request.submitted",
  LEAVE_REQUEST_CANCELLED: "leave_request.cancelled",
  LEAVE_REQUEST_APPROVED: "leave_request.approved",
  LEAVE_REQUEST_REJECTED: "leave_request.rejected",

  // Expenses
  EXPENSE_STARTED: "expense.started",
  EXPENSE_SUBMITTED: "expense.submitted",
  EXPENSE_CANCELLED: "expense.cancelled",
  EXPENSE_APPROVED: "expense.approved",

  // Travel
  TRAVEL_REQUEST_STARTED: "travel_request.started",
  TRAVEL_REQUEST_SUBMITTED: "travel_request.submitted",
  TRAVEL_REQUEST_CANCELLED: "travel_request.cancelled",
  TRAVEL_REQUEST_APPROVED: "travel_request.approved",

  // Payroll
  PAYROLL_RUN_STARTED: "payroll.run_started",
  PAYROLL_RUN_COMPLETED: "payroll.run_completed",
  PAYROLL_IMPORTED: "payroll.imported",

  // HRMS
  AGREEMENT_UPLOADED: "agreement.uploaded",
  AGREEMENT_DOWNLOADED: "agreement.downloaded",

  // Aria
  ARIA_MESSAGE_SENT: "aria.message_sent",
  ARIA_RESPONSE_RECEIVED: "aria.response_received",
  ARIA_FEEDBACK_GIVEN: "aria.feedback_given",

  // Messaging
  MESSAGE_SENT: "message.sent",

  // Projects
  PROJECT_CREATED: "project.created",
  TASK_CREATED: "task.created",
  TASK_STATUS_CHANGED: "task.status_changed",

  // Sales CRM
  LEAD_CREATED: "lead.created",
  LEAD_CONVERTED: "lead.converted",
  DEAL_CREATED: "deal.created",
  DEAL_STAGE_CHANGED: "deal.stage_changed",
  DEAL_WON: "deal.won",
  DEAL_LOST: "deal.lost",

  // Partner CRM
  PARTNER_CREATED: "partner.created",
  PARTNER_NOTE_ADDED: "partner.note_added",

  // Survey
  SURVEY_OPENED: "survey.opened",
  SURVEY_RESPONSE_SUBMITTED: "survey_response.submitted",

  // Learning
  COURSE_STARTED: "course.started",
  COURSE_COMPLETED: "course.completed",

  // Visa / Benefits / Careers
  VISA_REQUEST_SUBMITTED: "visa_request.submitted",
  BENEFIT_ENROLLED: "benefit.enrolled",
  APPLICATION_RECEIVED: "application.received",

  // Legal / Dataroom
  DOCUMENT_VIEWED: "document.viewed",
  DOCUMENT_DOWNLOADED: "document.downloaded",

  // Configuration
  ROLE_ASSIGNED: "role.assigned",
  ROLE_REVOKED: "role.revoked",
  PROFILE_UPDATED: "profile.updated",
  INTEGRATION_CONNECTED: "integration.connected",

  // Errors
  FORM_VALIDATION_FAILED: "form.validation_failed",
  PERMISSION_DENIED: "permission.denied",
} as const;

// ─── Module enum used by module.viewed ─────────────────────────────────────

export type ModuleId =
  | "home"
  | "aria"
  | "messaging"
  | "projects"
  | "partner_crm"
  | "sales_crm"
  | "employees"
  | "leave"
  | "travel"
  | "careers"
  | "survey"
  | "payroll"
  | "legal"
  | "hrms"
  | "learning"
  | "visa"
  | "benefits"
  | "my_portal"
  | "admin"
  | "settings";

export type EntityCode = "TH" | "IN" | "VN" | "ID";

// ─── Per-event property types ──────────────────────────────────────────────

export interface SessionStartedProps {
  source: "login" | "token_refresh" | "sso";
}

export interface SessionEndedProps {
  duration_seconds?: number;
}

export interface ModuleViewedProps {
  module: ModuleId;
  sub_section?: string;
  source?: "sidebar" | "link" | "deep_link" | "search" | "notification";
}

export interface SearchPerformedProps {
  query_length: number;
  results_count?: number;
  result_clicked?: boolean;
}

export interface LeaveRequestSubmittedProps {
  leave_type_code: string;
  days: number;
  is_self: boolean;
}

export interface ExpenseSubmittedProps {
  amount_thb: number;
  category: string;
  has_receipt: boolean;
}

export interface TravelRequestSubmittedProps {
  trip_type: "domestic" | "international";
  destination_country?: string;
  estimated_cost_thb?: number;
}

export interface ManutAiMessageSentProps {
  preset?: string;
  prompt_length: number;
  context_modules?: string;
}

export interface AriaResponseReceivedProps {
  latency_ms: number;
  tokens_in?: number;
  tokens_out?: number;
  streaming?: boolean;
  error: boolean;
}

export interface ManutAiFeedbackProps {
  rating: "up" | "down";
}

export interface MessageSentProps {
  thread_type: "direct" | "group" | "channel";
  has_attachment: boolean;
  char_count: number;
}

export interface TaskCreatedProps {
  project_id: string;
}

export interface TaskStatusChangedProps {
  task_id: string;
  from_status: string;
  to_status: string;
}

export interface LeadCreatedProps {
  source_code?: string;
}

export interface DealCreatedProps {
  amount_thb?: number;
  stage: string;
}

export interface DealStageChangedProps {
  deal_id: string;
  from_stage: string;
  to_stage: string;
}

export interface PartnerNoteAddedProps {
  partner_id: string;
}

export interface SurveyOpenedProps {
  survey_id: string;
}

export interface SurveyResponseSubmittedProps {
  survey_id: string;
  completion_seconds?: number;
}

export interface CourseStartedProps {
  course_id: string;
}

export interface CourseCompletedProps {
  course_id: string;
  completion_seconds?: number;
}

export interface VisaRequestSubmittedProps {
  visa_type?: string;
}

export interface BenefitEnrolledProps {
  benefit_id: string;
}

export interface DocumentViewProps {
  document_id: string;
  document_kind: "legal" | "dataroom" | "hrms_agreement" | "payroll_slip";
}

export interface ProfileUpdatedProps {
  fields_changed: string;
}

export interface IntegrationConnectedProps {
  provider: "gmail" | "google_calendar" | "slack" | "gemini";
}

// ─── Per-event functions (typed wrappers around tracking.capture) ──────────
// One function per event. Cannot be replaced with a generic wrapper without
// losing compile-time guarantees on properties.

export const trackSessionStarted = (props: SessionStartedProps) =>
  tracking.capture(EVENTS.SESSION_STARTED, props);

export const trackSessionEnded = (props: SessionEndedProps = {}) =>
  tracking.capture(EVENTS.SESSION_ENDED, props);

export const trackModuleViewed = (props: ModuleViewedProps) =>
  tracking.capture(EVENTS.MODULE_VIEWED, props);

export const trackSearchPerformed = (props: SearchPerformedProps) =>
  tracking.capture(EVENTS.SEARCH_PERFORMED, props);

export const trackLeaveRequestStarted = () =>
  tracking.capture(EVENTS.LEAVE_REQUEST_STARTED);

export const trackLeaveRequestSubmitted = (props: LeaveRequestSubmittedProps) =>
  tracking.capture(EVENTS.LEAVE_REQUEST_SUBMITTED, props);

export const trackLeaveRequestCancelled = () =>
  tracking.capture(EVENTS.LEAVE_REQUEST_CANCELLED);

export const trackExpenseStarted = () =>
  tracking.capture(EVENTS.EXPENSE_STARTED);

export const trackExpenseSubmitted = (props: ExpenseSubmittedProps) =>
  tracking.capture(EVENTS.EXPENSE_SUBMITTED, props);

export const trackExpenseCancelled = () =>
  tracking.capture(EVENTS.EXPENSE_CANCELLED);

export const trackTravelRequestStarted = () =>
  tracking.capture(EVENTS.TRAVEL_REQUEST_STARTED);

export const trackTravelRequestSubmitted = (
  props: TravelRequestSubmittedProps,
) => tracking.capture(EVENTS.TRAVEL_REQUEST_SUBMITTED, props);

export const trackTravelRequestCancelled = () =>
  tracking.capture(EVENTS.TRAVEL_REQUEST_CANCELLED);

export const trackPayrollImported = (props: {
  row_count: number;
  error_count: number;
}) => tracking.capture(EVENTS.PAYROLL_IMPORTED, props);

export const trackAgreementUploaded = (props: { agreement_type?: string }) =>
  tracking.capture(EVENTS.AGREEMENT_UPLOADED, props);

export const trackAriaMessageSent = (props: ManutAiMessageSentProps) =>
  tracking.capture(EVENTS.ARIA_MESSAGE_SENT, props);

export const trackAriaResponseReceived = (props: AriaResponseReceivedProps) =>
  tracking.capture(EVENTS.ARIA_RESPONSE_RECEIVED, props);

export const trackAriaFeedback = (props: ManutAiFeedbackProps) =>
  tracking.capture(EVENTS.ARIA_FEEDBACK_GIVEN, props);

export const trackMessageSent = (props: MessageSentProps) =>
  tracking.capture(EVENTS.MESSAGE_SENT, props);

export const trackProjectCreated = () =>
  tracking.capture(EVENTS.PROJECT_CREATED);

export const trackTaskCreated = (props: TaskCreatedProps) =>
  tracking.capture(EVENTS.TASK_CREATED, props);

export const trackTaskStatusChanged = (props: TaskStatusChangedProps) =>
  tracking.capture(EVENTS.TASK_STATUS_CHANGED, props);

export const trackLeadCreated = (props: LeadCreatedProps = {}) =>
  tracking.capture(EVENTS.LEAD_CREATED, props);

export const trackDealCreated = (props: DealCreatedProps) =>
  tracking.capture(EVENTS.DEAL_CREATED, props);

export const trackDealStageChanged = (props: DealStageChangedProps) =>
  tracking.capture(EVENTS.DEAL_STAGE_CHANGED, props);

export const trackPartnerCreated = () =>
  tracking.capture(EVENTS.PARTNER_CREATED);

export const trackPartnerNoteAdded = (props: PartnerNoteAddedProps) =>
  tracking.capture(EVENTS.PARTNER_NOTE_ADDED, props);

export const trackSurveyOpened = (props: SurveyOpenedProps) =>
  tracking.capture(EVENTS.SURVEY_OPENED, props);

export const trackSurveyResponseSubmitted = (
  props: SurveyResponseSubmittedProps,
) => tracking.capture(EVENTS.SURVEY_RESPONSE_SUBMITTED, props);

export const trackCourseStarted = (props: CourseStartedProps) =>
  tracking.capture(EVENTS.COURSE_STARTED, props);

export const trackCourseCompleted = (props: CourseCompletedProps) =>
  tracking.capture(EVENTS.COURSE_COMPLETED, props);

export const trackVisaRequestSubmitted = (props: VisaRequestSubmittedProps) =>
  tracking.capture(EVENTS.VISA_REQUEST_SUBMITTED, props);

export const trackBenefitEnrolled = (props: BenefitEnrolledProps) =>
  tracking.capture(EVENTS.BENEFIT_ENROLLED, props);

export const trackDocumentViewed = (props: DocumentViewProps) =>
  tracking.capture(EVENTS.DOCUMENT_VIEWED, props);

export const trackDocumentDownloaded = (props: DocumentViewProps) =>
  tracking.capture(EVENTS.DOCUMENT_DOWNLOADED, props);

export const trackProfileUpdated = (props: ProfileUpdatedProps) =>
  tracking.capture(EVENTS.PROFILE_UPDATED, props);

export const trackIntegrationConnected = (props: IntegrationConnectedProps) =>
  tracking.capture(EVENTS.INTEGRATION_CONNECTED, props);
