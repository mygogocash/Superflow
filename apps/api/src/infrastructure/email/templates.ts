const BRAND = {
  name: "Manut",
  // Manut Brand CI v1.0 email palette: Ink actions on Paper, Stone borders.
  primaryColor: "#0B0B0A",
  primaryDark: "#282826",
  bgColor: "#F7F7F3",
  textColor: "#0B0B0A",
  mutedColor: "#555550",
  borderColor: "#E3E2DC",
  logoUrl: "https://manut.xyz/favicon.ico",
  url: "https://manut.xyz",
} as const;

type TemplateVariables = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface EmailContent {
  subject: string;
  html: string;
  templateId: string;
  variables: TemplateVariables;
}

function baseLayout(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${BRAND.name}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.bgColor};font-family:'Geist','Segoe UI','Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.bgColor};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(13,27,42,0.06);">
<!-- Header -->
<tr>
<td style="background-color:${BRAND.primaryColor};padding:24px 32px;text-align:center;">
<img src="${BRAND.logoUrl}" alt="${BRAND.name}" width="36" height="36" style="vertical-align:middle;border-radius:8px;margin-right:12px;"/>
<span style="color:#ffffff;font-size:20px;font-weight:700;vertical-align:middle;letter-spacing:-0.3px;">${BRAND.name}</span>
</td>
</tr>
<!-- Body -->
<tr>
<td style="padding:32px;color:${BRAND.textColor};font-size:14px;line-height:1.65;">
${body}
</td>
</tr>
<!-- Footer -->
<tr>
<td style="padding:20px 32px;border-top:1px solid ${BRAND.borderColor};text-align:center;">
<p style="margin:0;font-size:12px;color:${BRAND.mutedColor};line-height:1.5;">
${BRAND.name} &middot; <a href="${BRAND.url}" style="color:${BRAND.primaryColor};text-decoration:none;">${BRAND.name} Portal</a>
</p>
<p style="margin:6px 0 0;font-size:11px;color:${BRAND.mutedColor};">
This is an automated message. Please do not reply directly to this email.
</p>
</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function actionButton(label: string, url: string): string {
  const safeUrl = escapeHtml(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
<tr><td style="border-radius:8px;background-color:${BRAND.primaryColor};">
<a href="${safeUrl}" target="_blank" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;border-radius:8px;">${escapeHtml(label)}</a>
</td></tr></table>`;
}

function statusBadge(label: string, color: string): string {
  return `<span style="display:inline-block;padding:4px 12px;font-size:12px;font-weight:600;color:#ffffff;background-color:${color};border-radius:20px;">${escapeHtml(label)}</span>`;
}

/** "it-crm-task-assigned" -> "It Crm Task Assigned"; "employeeName" -> "Employee Name". */
export function humanizeTemplateId(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

const GENERIC_SKIP_KEYS = new Set([
  "subject",
  "title",
  "body",
  "url",
  "actionurl",
  "cta",
  "ctaurl",
  "actionlabel",
]);

/**
 * Branded fallback for senders that only provide a templateId + variables
 * (the legacy onewave server-side templates that had no local HTML). Renders a
 * readable, on-brand email from the variables so no notification is lost after
 * the Resend cutover; bespoke templates can replace these incrementally.
 */
export function renderGenericEmail(
  templateId: string,
  variables: TemplateVariables = {},
): { subject: string; html: string } {
  const pick = (k: string): string | undefined => {
    const hit = Object.entries(variables).find(
      ([key]) => key.toLowerCase() === k,
    );
    return hit && hit[1] != null ? String(hit[1]) : undefined;
  };
  const subject =
    pick("subject") ?? pick("title") ?? humanizeTemplateId(templateId);
  const intro = pick("body");
  const url = pick("url") ?? pick("actionurl") ?? pick("ctaurl");
  const ctaLabel =
    pick("actionlabel") ?? pick("cta") ?? `Open in ${BRAND.name}`;
  const rows = Object.entries(variables)
    .filter(
      ([k, v]) =>
        v != null && v !== "" && !GENERIC_SKIP_KEYS.has(k.toLowerCase()),
    )
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};width:40%;color:${BRAND.mutedColor};"><strong>${escapeHtml(humanizeTemplateId(k))}</strong></td><td style="padding:8px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};">${escapeHtml(String(v))}</td></tr>`,
    )
    .join("");
  const body = `${intro ? `<p style="margin:0 0 16px;">${escapeHtml(intro)}</p>` : ""}${rows
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">${rows}</table>`
      : ""}${url ? actionButton(escapeHtml(ctaLabel), url) : ""}`;
  return { subject, html: baseLayout(body) };
}

// ─── Leave Emails ────────────────────────────────────────

export function leaveSubmittedEmail(data: {
  approverName: string;
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  reason: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "submitted-leave-request",
    variables: data,
    subject: `Leave Request from ${data.employeeName}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.approverName)}</strong>,</p>
<p style="margin:0 0 20px;color:${BRAND.mutedColor};">${escapeHtml(data.employeeName)} has submitted a leave request that requires your review.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Type:</strong> ${escapeHtml(data.leaveType)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>From:</strong> ${escapeHtml(data.startDate)} &rarr; <strong>To:</strong> ${escapeHtml(data.endDate)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Reason:</strong> ${escapeHtml(data.reason || "—")}</td></tr>
</table>
${actionButton("Review Request", data.portalUrl)}
`),
  };
}

export function leaveEscalationReminderEmail(data: {
  approverName: string;
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  portalUrl: string;
  reminderCount: number;
}): EmailContent {
  return {
    templateId: "escalation-reminder",
    variables: data,
    subject: `[Reminder ${data.reminderCount}] Leave pending — ${data.employeeName}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.approverName)}</strong>,</p>
<p style="margin:0 0 20px;color:${BRAND.mutedColor};">This is a reminder: a leave request from <strong>${escapeHtml(data.employeeName)}</strong> is still awaiting your review.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Type:</strong> ${escapeHtml(data.leaveType)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>From:</strong> ${escapeHtml(data.startDate)} &rarr; <strong>To:</strong> ${escapeHtml(data.endDate)}</td></tr>
</table>
${actionButton("Review Request", data.portalUrl)}
`),
  };
}

export function leaveForwardedEmail(data: {
  delegateName: string;
  forwardedByName: string;
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "forwarded-leave-request",
    variables: data,
    subject: `Leave approval delegated to you — ${data.employeeName}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.delegateName)}</strong>,</p>
<p style="margin:0 0 20px;color:${BRAND.mutedColor};"><strong>${escapeHtml(data.forwardedByName)}</strong> has asked you to review a leave request for <strong>${escapeHtml(data.employeeName)}</strong>.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Type:</strong> ${escapeHtml(data.leaveType)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>From:</strong> ${escapeHtml(data.startDate)} &rarr; <strong>To:</strong> ${escapeHtml(data.endDate)}</td></tr>
</table>
${actionButton("Review Request", data.portalUrl)}
`),
  };
}

export function leaveDeskSummaryEmail(data: {
  employeeName: string;
  employeeEmail: string;
  department: string | null;
  entity: string | null;
  leaveType: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  approverName: string;
  portalUrl: string;
}): EmailContent {
  const rows: Array<[string, string]> = [
    ["Name", data.employeeName],
    ["Email", data.employeeEmail],
    ["Department", data.department ?? "—"],
    ["Entity", data.entity ?? "—"],
    ["Leave Type", data.leaveType],
    ["From", data.startDate],
    ["To", data.endDate],
    ["Working days", data.days.toString()],
    ["Reason", data.reason ?? ""],
    ["Approver", data.approverName],
  ];
  const body = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};width:42%;color:${BRAND.mutedColor};"><strong>${k}</strong></td><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  return {
    templateId: "desk-summary",
    variables: data,
    subject: `Leave request approved — ${data.employeeName}`,
    html: baseLayout(`
<p style="margin:0 0 14px;">A leave request has been ${statusBadge("Approved", "#28a060")}.</p>
<p style="margin:0 0 18px;font-size:13px;color:${BRAND.mutedColor};">Summary:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${body}
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

export function expenseDeskSummaryEmail(data: {
  employeeName: string;
  employeeEmail: string;
  department: string | null;
  entity: string | null;
  reportTitle: string;
  amount: string;
  expenseCount: number;
  notes: string | null;
  // For "Submitted" events the approver is the submitter themselves
  // and the line is shown as "Submitted by" rather than "Approver".
  approverName: string;
  portalUrl: string;
  // Drives the subject + status badge. Defaults to "approved" to keep
  // existing call sites unchanged.
  event?: "submitted" | "approved";
}): EmailContent {
  const event = data.event ?? "approved";
  const isSubmitted = event === "submitted";
  const rows: Array<[string, string]> = [
    ["Name", data.employeeName],
    ["Email", data.employeeEmail],
    ["Department", data.department ?? "—"],
    ["Entity", data.entity ?? "—"],
    ["Report Title", data.reportTitle],
    ["Total Amount", data.amount],
    ["Line items", data.expenseCount.toString()],
    ["Notes", data.notes ?? ""],
    [isSubmitted ? "Submitted by" : "Approver", data.approverName],
  ];
  const body = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};width:42%;color:${BRAND.mutedColor};"><strong>${k}</strong></td><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  const subject = isSubmitted
    ? `Expense report submitted — ${data.employeeName}`
    : `Expense report approved — ${data.employeeName}`;
  const badge = isSubmitted
    ? statusBadge("Submitted", "#d99000")
    : statusBadge("Approved", "#28a060");
  const lead = isSubmitted
    ? "An expense report has been"
    : "An expense report has been";
  return {
    templateId: "expense-desk-summary",
    variables: {
      employeeName: data.employeeName,
      employeeEmail: data.employeeEmail,
      department: data.department,
      entity: data.entity,
      reportTitle: data.reportTitle,
      amount: data.amount,
      expenseCount: data.expenseCount,
      notes: data.notes,
      approverName: data.approverName,
      portalUrl: data.portalUrl,
    },
    subject,
    html: baseLayout(`
<p style="margin:0 0 14px;">${lead} ${badge}.</p>
<p style="margin:0 0 18px;font-size:13px;color:${BRAND.mutedColor};">Summary:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${body}
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

export function leaveApprovedEmail(data: {
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  approverName: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "leave-approved",
    variables: data,
    subject: `Leave Request Approved — ${data.leaveType}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.employeeName)}</strong>,</p>
<p style="margin:0 0 20px;">Your leave request has been ${statusBadge("Approved", "#28a060")} by <strong>${escapeHtml(data.approverName)}</strong>.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Type:</strong> ${escapeHtml(data.leaveType)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Period:</strong> ${escapeHtml(data.startDate)} &rarr; ${escapeHtml(data.endDate)}</td></tr>
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

export function leaveRejectedEmail(data: {
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  approverName: string;
  rejectionReason?: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "rejected-leave-request",
    variables: {
      ...data,
      rejectionReason: data.rejectionReason ?? "",
    },
    subject: `Leave Request Rejected — ${data.leaveType}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.employeeName)}</strong>,</p>
<p style="margin:0 0 20px;">Your leave request has been ${statusBadge("Rejected", "#dc2626")} by <strong>${escapeHtml(data.approverName)}</strong>.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Type:</strong> ${escapeHtml(data.leaveType)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Period:</strong> ${escapeHtml(data.startDate)} &rarr; ${escapeHtml(data.endDate)}</td></tr>
${data.rejectionReason ? `<tr><td style="padding:12px 16px;font-size:13px;"><strong>Reason:</strong> ${escapeHtml(data.rejectionReason)}</td></tr>` : ""}
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

export function leaveCancelledEmail(data: {
  recipientName: string;
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "cancelled-leave-request",
    variables: data,
    subject: `Leave Cancelled — ${data.employeeName}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.recipientName)}</strong>,</p>
<p style="margin:0 0 20px;">${escapeHtml(data.employeeName)} has ${statusBadge("Cancelled", "#6b7990")} their leave request.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Type:</strong> ${escapeHtml(data.leaveType)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Period:</strong> ${escapeHtml(data.startDate)} &rarr; ${escapeHtml(data.endDate)}</td></tr>
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

// ─── Travel Emails ───────────────────────────────────────

export function travelSubmittedEmail(data: {
  approverName: string;
  employeeName: string;
  origin?: string | null;
  destination: string;
  startDate: string;
  endDate: string;
  purpose: string;
  portalUrl: string;
}): EmailContent {
  const originRow = data.origin
    ? `<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Origin:</strong> ${escapeHtml(data.origin)}</td></tr>`
    : "";
  return {
    templateId: "travel-submitted",
    variables: {
      ...data,
      origin: data.origin ?? "",
    },
    subject: `Travel Request from ${data.employeeName}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.approverName)}</strong>,</p>
<p style="margin:0 0 20px;">${escapeHtml(data.employeeName)} has submitted a travel request for your review.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${originRow}
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Destination:</strong> ${escapeHtml(data.destination)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Period:</strong> ${escapeHtml(data.startDate)} &rarr; ${escapeHtml(data.endDate)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Purpose:</strong> ${escapeHtml(data.purpose || "—")}</td></tr>
</table>
${actionButton("Review Request", data.portalUrl)}
`),
  };
}

export function travelApprovedEmail(data: {
  employeeName: string;
  origin?: string | null;
  destination: string;
  startDate: string;
  endDate: string;
  approverName: string;
  portalUrl: string;
}): EmailContent {
  const originRow = data.origin
    ? `<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Origin:</strong> ${escapeHtml(data.origin)}</td></tr>`
    : "";
  return {
    templateId: "travel-approved",
    variables: {
      ...data,
      origin: data.origin ?? "",
    },
    subject: `Travel Request Approved — ${data.destination}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.employeeName)}</strong>,</p>
<p style="margin:0 0 20px;">Your travel request has been ${statusBadge("Approved", "#28a060")} by <strong>${escapeHtml(data.approverName)}</strong>.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${originRow}
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Destination:</strong> ${escapeHtml(data.destination)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Period:</strong> ${escapeHtml(data.startDate)} &rarr; ${escapeHtml(data.endDate)}</td></tr>
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

// Long-form summary the travel desk asked for (May 2026). Sent to a
// configurable list of recipients once a request reaches the
// approved state. Layout intentionally mirrors the plain-text
// template HR uses today so the desk can scan it in Outlook with no
// extra rendering.
export function travelDeskSummaryEmail(data: {
  employeeName: string;
  employeeEmail: string;
  approverName: string;
  department: string | null;
  expenseTypes: string[];
  destination: string;
  hotelLocationPreference: string | null;
  preferredHotel: string | null;
  hotelDetails: string | null;
  departureDate: string;
  origin: string | null;
  returnDate: string;
  flightType: string | null;
  departureTimePreference: string | null;
  seatingPreference: string | null;
  mealPreference: string | null;
  notes: string | null;
  portalUrl: string;
}): EmailContent {
  const rows: Array<[string, string]> = [
    ["Name", data.employeeName],
    ["Your Email", data.employeeEmail],
    ["Approver", data.approverName],
    ["Team / Department", data.department ?? "—"],
    ["Expense Type", data.expenseTypes.join(", ") || "—"],
    ["Meeting / Event Location", data.destination],
    [
      "Do you need hotel closeby meeting location or airport?",
      hotelPreferenceLabel(data.hotelLocationPreference),
    ],
    [
      "Hotel specific request if available",
      data.preferredHotel || data.hotelDetails || "",
    ],
    ["Departure", data.departureDate],
    ["Departure From", data.origin ?? "—"],
    ["Arriving To", data.destination],
    ["Return", data.returnDate],
    ["Flight Details", flightTypeLabel(data.flightType)],
    ["Flight Time Preference", data.departureTimePreference ?? ""],
    [
      "Seating preference (if available)",
      seatingPreferenceLabel(data.seatingPreference),
    ],
    ["Meal preference (if available)", data.mealPreference ?? ""],
    ["Remark", data.notes ?? ""],
  ];
  const body = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};width:42%;color:${BRAND.mutedColor};"><strong>${k}</strong></td><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  return {
    templateId: "travel-desk-summary",
    variables: {
      employeeName: data.employeeName,
      employeeEmail: data.employeeEmail,
      approverName: data.approverName,
      department: data.department,
      expenseTypes: data.expenseTypes.join(", "),
      destination: data.destination,
      hotelLocationPreference: data.hotelLocationPreference,
      preferredHotel: data.preferredHotel || data.hotelDetails || "",
      departureDate: data.departureDate,
      origin: data.origin,
      returnDate: data.returnDate,
      flightType: data.flightType,
      departureTimePreference: data.departureTimePreference,
      seatingPreference: data.seatingPreference,
      mealPreference: data.mealPreference,
      notes: data.notes,
      portalUrl: data.portalUrl,
    },
    subject: `Travel request approved — ${data.employeeName}`,
    html: baseLayout(`
<p style="margin:0 0 14px;">A travel request has been ${statusBadge("Approved", "#28a060")}.</p>
<p style="margin:0 0 18px;font-size:13px;color:${BRAND.mutedColor};">Summary:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${body}
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

function hotelPreferenceLabel(v: string | null): string {
  if (v === "near_meeting") return "Meeting Location";
  if (v === "near_airport") return "Airport";
  return v ?? "";
}

function flightTypeLabel(v: string | null): string {
  if (v === "round_trip") return "Round Trip";
  if (v === "one_way") return "One Way";
  if (v === "multi_trip") return "Multi Trip";
  return v ?? "";
}

function seatingPreferenceLabel(v: string | null): string {
  if (v === "aisle") return "Aisle";
  if (v === "window") return "Window";
  if (v === "other") return "Other";
  return v ?? "";
}

export function escapeHtml(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Survey Forms ────────────────────────────────────────

export function surveyFormSubmittedEmail(data: {
  formTitle: string;
  respondentName: string;
  submittedAt: string;
  responseCount: number;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "survey-form-response-submitted",
    variables: data,
    subject: `New response to "${data.formTitle}"`,
    html: baseLayout(`
<p style="margin:0 0 20px;">A new response has been submitted to a form you manage.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Form:</strong> ${escapeHtml(data.formTitle)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Respondent:</strong> ${escapeHtml(data.respondentName)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Submitted:</strong> ${escapeHtml(data.submittedAt)} &middot; <strong>Total responses:</strong> ${data.responseCount}</td></tr>
</table>
${actionButton("View Responses", data.portalUrl)}
`),
  };
}

// ─── Certificates ────────────────────────────────────────

export function certificateIssuedEmail(data: {
  recipientName: string;
  title: string;
  message: string;
  issuerName: string;
  downloadUrl: string;
}): EmailContent {
  return {
    templateId: "certificate-issued",
    variables: data,
    subject: `You've received a certificate: ${data.title}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Congratulations <strong>${escapeHtml(data.recipientName)}</strong>! 🎉</p>
<p style="margin:0 0 20px;color:${BRAND.mutedColor};">${escapeHtml(data.issuerName)} has issued you a certificate of recognition.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Award:</strong> ${escapeHtml(data.title)}</td></tr>
${data.message ? `<tr><td style="padding:12px 16px;font-size:13px;">${escapeHtml(data.message)}</td></tr>` : ""}
</table>
${actionButton("Download Certificate", data.downloadUrl)}
<p style="margin:16px 0 0;font-size:12px;color:${BRAND.mutedColor};">The download link is valid for 7 days.</p>
`),
  };
}

export function travelRejectedEmail(data: {
  employeeName: string;
  origin?: string | null;
  destination: string;
  startDate: string;
  endDate: string;
  approverName: string;
  rejectionReason?: string;
  portalUrl: string;
}): EmailContent {
  const originRow = data.origin
    ? `<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Origin:</strong> ${escapeHtml(data.origin)}</td></tr>`
    : "";
  return {
    templateId: "travel-rejected",
    variables: {
      ...data,
      origin: data.origin ?? "",
      rejectionReason: data.rejectionReason ?? "",
    },
    subject: `Travel Request Rejected — ${data.destination}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.employeeName)}</strong>,</p>
<p style="margin:0 0 20px;">Your travel request has been ${statusBadge("Rejected", "#dc2626")} by <strong>${escapeHtml(data.approverName)}</strong>.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${originRow}
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Destination:</strong> ${escapeHtml(data.destination)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Period:</strong> ${escapeHtml(data.startDate)} &rarr; ${escapeHtml(data.endDate)}</td></tr>
${data.rejectionReason ? `<tr><td style="padding:12px 16px;font-size:13px;"><strong>Reason:</strong> ${escapeHtml(data.rejectionReason)}</td></tr>` : ""}
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

export function travelCancelledEmail(data: {
  recipientName: string;
  employeeName: string;
  origin?: string | null;
  destination: string;
  startDate: string;
  endDate: string;
  portalUrl: string;
}): EmailContent {
  const originRow = data.origin
    ? `<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Origin:</strong> ${escapeHtml(data.origin)}</td></tr>`
    : "";
  return {
    templateId: "travel-cancelled",
    variables: {
      ...data,
      origin: data.origin ?? "",
    },
    subject: `Travel Cancelled — ${data.employeeName}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.recipientName)}</strong>,</p>
<p style="margin:0 0 20px;">${escapeHtml(data.employeeName)} has ${statusBadge("Cancelled", "#6b7990")} their travel request.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${originRow}
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Destination:</strong> ${escapeHtml(data.destination)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Period:</strong> ${escapeHtml(data.startDate)} &rarr; ${escapeHtml(data.endDate)}</td></tr>
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

// ─── Cash Advance Emails ─────────────────────────────────

function moneyRow(label: string, value: string): string {
  return `<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>${label}:</strong> ${value}</td></tr>`;
}

// Sent to the approver whose step a cash-advance request has reached.
export function cashAdvanceSubmittedEmail(data: {
  approverName: string;
  employeeName: string;
  requestCode: string;
  amount: string;
  stepName: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "cash-advance-request-awaiting",
    variables: data,
    subject: `Cash advance ${data.requestCode} needs your approval`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.approverName)}</strong>,</p>
<p style="margin:0 0 20px;">${escapeHtml(data.employeeName)} has a cash advance request awaiting your approval at the <strong>${escapeHtml(data.stepName)}</strong> step.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${moneyRow("Request", escapeHtml(data.requestCode))}
${moneyRow("Employee", escapeHtml(data.employeeName))}
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Requested:</strong> ${escapeHtml(data.amount)}</td></tr>
</table>
${actionButton("Review Request", data.portalUrl)}
`),
  };
}

// Sent to the employee once every chain step is approved.
export function cashAdvanceApprovedEmail(data: {
  employeeName: string;
  requestCode: string;
  approvedAmount: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "cash-advance-request-fully-approved",
    variables: data,
    subject: `Cash advance ${data.requestCode} approved`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.employeeName)}</strong>,</p>
<p style="margin:0 0 20px;">Your cash advance request ${escapeHtml(data.requestCode)} has been ${statusBadge("Approved", "#28a060")} through the full approval chain. Finance will arrange disbursement.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${moneyRow("Request", escapeHtml(data.requestCode))}
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Approved amount:</strong> ${escapeHtml(data.approvedAmount)}</td></tr>
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

// Sent to the HR / finance recipients on full approval, with the payout
// detail they need to action disbursement.
export function cashAdvanceHrSummaryEmail(data: {
  employeeName: string;
  requestCode: string;
  approvedAmount: string;
  payoutMode: string;
  bankName?: string | null;
  bankAccountNo?: string | null;
  bankCountry?: string | null;
  swiftCode?: string | null;
  notes?: string | null;
  portalUrl: string;
}): EmailContent {
  const bankRows =
    data.payoutMode === "bank-transfer"
      ? [
          moneyRow("Bank", escapeHtml(data.bankName ?? "") || "—"),
          moneyRow("Account No", escapeHtml(data.bankAccountNo ?? "") || "—"),
          moneyRow("Bank country", escapeHtml(data.bankCountry ?? "") || "—"),
          moneyRow("SWIFT", escapeHtml(data.swiftCode ?? "") || "—"),
        ].join("")
      : "";
  return {
    templateId: "cash-advance-approved-2",
    variables: {
      requestCode: data.requestCode,
      employeeName: data.employeeName,
      approvedAmount: data.approvedAmount,
      payoutMode: data.payoutMode,
      bankDetailsHtml: bankRows,
      notes: data.notes ?? "",
      portalUrl: data.portalUrl,
    },
    subject: `Cash advance approved — action disbursement (${data.requestCode})`,
    html: baseLayout(`
<p style="margin:0 0 20px;">Cash advance <strong>${escapeHtml(data.requestCode)}</strong> for <strong>${escapeHtml(data.employeeName)}</strong> is fully approved and ready for disbursement.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${moneyRow("Approved amount", escapeHtml(data.approvedAmount))}
${moneyRow("Payout mode", escapeHtml(data.payoutMode))}
${bankRows}
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Notes:</strong> ${escapeHtml(data.notes ?? "—")}</td></tr>
</table>
${actionButton("Open Cash Advance", data.portalUrl)}
`),
  };
}

// Sent to the employee when any chain step rejects the request.
export function cashAdvanceRejectedEmail(data: {
  employeeName: string;
  requestCode: string;
  approverName: string;
  reason?: string | null;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "cash-advance-request-rejected",
    variables: {
      ...data,
      reason: data.reason ?? "",
    },
    subject: `Cash advance ${data.requestCode} rejected`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.employeeName)}</strong>,</p>
<p style="margin:0 0 20px;">Your cash advance request ${escapeHtml(data.requestCode)} was ${statusBadge("Rejected", "#d04545")} by <strong>${escapeHtml(data.approverName)}</strong>.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Reason:</strong> ${escapeHtml(data.reason ?? "—")}</td></tr>
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

// ─── Visa Emails ─────────────────────────────────────────

export function visaExpiryReminderEmail(data: {
  employeeName: string;
  country: string;
  visa: {
    expiryDate: string;
    daysLeft: number;
    visaType: string;
  } | null;
  workPermit: {
    expiryDate: string;
    daysLeft: number;
    permitNumber?: string;
  } | null;
  portalUrl: string;
}): EmailContent {
  const earliest = Math.min(
    data.visa ? data.visa.daysLeft : Number.POSITIVE_INFINITY,
    data.workPermit ? data.workPermit.daysLeft : Number.POSITIVE_INFINITY,
  );
  const items = [
    data.visa
      ? `<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Visa (${escapeHtml(data.visa.visaType)}):</strong> expires ${escapeHtml(data.visa.expiryDate)} &middot; ${data.visa.daysLeft} day${data.visa.daysLeft === 1 ? "" : "s"} left</td></tr>`
      : "",
    data.workPermit
      ? `<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Work Permit${data.workPermit.permitNumber ? ` (${escapeHtml(data.workPermit.permitNumber)})` : ""}:</strong> expires ${escapeHtml(data.workPermit.expiryDate)} &middot; ${data.workPermit.daysLeft} day${data.workPermit.daysLeft === 1 ? "" : "s"} left</td></tr>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  return {
    templateId: "visa-expiry-reminder-2",
    variables: {
      employeeName: data.employeeName,
      country: data.country,
      summaryText: `A document tied to your stay in ${escapeHtml(data.country)} is approaching its expiry date.`,
      documentRowsHtml: items,
      portalUrl: data.portalUrl,
    },
    subject: `Action needed — ${earliest} day${earliest === 1 ? "" : "s"} until your ${data.workPermit && !data.visa ? "work permit" : "visa"} expires`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.employeeName)}</strong>,</p>
<p style="margin:0 0 20px;">A document tied to your stay in ${escapeHtml(data.country)} is approaching its expiry date. Please coordinate with HR to begin the renewal process.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${items}
</table>
${actionButton("Open in Portal", data.portalUrl)}
`),
  };
}

// 90-day TM.47 immigration reminder. `offsetDays` is `dueDate - today`
// (positive while pre-due, negative once we're past the 90-day mark
// and into the final 7-day report window). HR copy expects three
// distinct phrasings: heads-up, advance window, final-day push.
export function ninetyDayReminderEmail(data: {
  employeeName: string;
  lastArrivalDate: string;
  dueDate: string;
  offsetDays: number;
  portalUrl: string;
}): EmailContent {
  let headline: string;
  let body: string;
  if (data.offsetDays < 0) {
    const daysOver = Math.abs(data.offsetDays);
    headline = `Final TM.47 report due — day ${daysOver} of 7`;
    body = `You are inside the <strong>7-day final reporting window</strong> for your 90-day notification (TM.47). The 90-day mark was on <strong>${escapeHtml(data.dueDate)}</strong>; reports must be lodged with Immigration before the window closes.`;
  } else if (data.offsetDays <= 15) {
    headline = `Submit TM.47 — ${data.offsetDays} day${data.offsetDays === 1 ? "" : "s"} until your 90-day mark`;
    body = `Your 90-day notification (TM.47) for the arrival on <strong>${escapeHtml(data.lastArrivalDate)}</strong> falls due on <strong>${escapeHtml(data.dueDate)}</strong>. The advance submission window is open — please coordinate with HR to file ahead of the deadline.`;
  } else {
    headline = `Heads-up: TM.47 in ${data.offsetDays} days`;
    body = `Your next 90-day notification (TM.47) for the arrival on <strong>${escapeHtml(data.lastArrivalDate)}</strong> is due on <strong>${escapeHtml(data.dueDate)}</strong>. No action needed yet — this is a heads-up so HR can plan the submission.`;
  }
  return {
    templateId: "visa-ninety-day-reminder",
    variables: {
      dueDate: data.dueDate,
      employeeName: data.employeeName,
      lastArrivalDate: data.lastArrivalDate,
      portalUrl: data.portalUrl,
    },
    subject: headline,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.employeeName)}</strong>,</p>
<p style="margin:0 0 20px;">${body}</p>
${actionButton("Open in Portal", data.portalUrl)}
`),
  };
}

// ─── Expense Emails ──────────────────────────────────────

export function expenseSubmittedEmail(data: {
  approverName: string;
  employeeName: string;
  title: string;
  amount: string;
  category: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "expense-submitted",
    variables: data,
    subject: `Expense Claim from ${data.employeeName}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.approverName)}</strong>,</p>
<p style="margin:0 0 20px;">${escapeHtml(data.employeeName)} has submitted an expense claim for your review.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Title:</strong> ${escapeHtml(data.title)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Amount:</strong> ${escapeHtml(data.amount)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Category:</strong> ${escapeHtml(data.category)}</td></tr>
</table>
${actionButton("Review Expense", data.portalUrl)}
`),
  };
}

export function expenseApprovedEmail(data: {
  employeeName: string;
  title: string;
  amount: string;
  approverName: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "expense-approved",
    variables: data,
    subject: `Expense Approved — ${data.title}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.employeeName)}</strong>,</p>
<p style="margin:0 0 20px;">Your expense claim has been ${statusBadge("Approved", "#28a060")} by <strong>${escapeHtml(data.approverName)}</strong>.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Title:</strong> ${escapeHtml(data.title)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Amount:</strong> ${escapeHtml(data.amount)}</td></tr>
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

export function expenseRejectedEmail(data: {
  employeeName: string;
  title: string;
  amount: string;
  approverName: string;
  rejectionReason?: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "expense-rejected",
    variables: {
      ...data,
      rejectionReason: data.rejectionReason ?? "",
    },
    subject: `Expense Rejected — ${data.title}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.employeeName)}</strong>,</p>
<p style="margin:0 0 20px;">Your expense claim has been ${statusBadge("Rejected", "#dc2626")} by <strong>${escapeHtml(data.approverName)}</strong>.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Title:</strong> ${escapeHtml(data.title)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Amount:</strong> ${escapeHtml(data.amount)}</td></tr>
${data.rejectionReason ? `<tr><td style="padding:12px 16px;font-size:13px;"><strong>Reason:</strong> ${escapeHtml(data.rejectionReason)}</td></tr>` : ""}
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

// Monthly submission nudge — fired on the 22nd for employees who have
// not yet filed their report for the current period. Thailand (`TH`)
// copy covers allowances; all other entities get reimbursement wording.
export function expenseMonthlySubmissionReminderEmail(data: {
  employeeName: string;
  periodLabel: string;
  portalUrl: string;
  variant: "thailand" | "international";
}): EmailContent {
  const isThailand = data.variant === "thailand";
  const subject = isThailand
    ? `Reminder: submit your ${escapeHtml(data.periodLabel)} monthly allowance`
    : `Reminder: submit your ${escapeHtml(data.periodLabel)} monthly reimbursement`;
  const checklist = isThailand
    ? `<ul style="margin:0 0 20px;padding-left:20px;font-size:14px;line-height:1.7;">
<li>Meal allowance</li>
<li>Transportation allowance</li>
<li>Phone allowance</li>
<li>Other reimbursements (as applicable)</li>
</ul>`
    : `<ul style="margin:0 0 20px;padding-left:20px;font-size:14px;line-height:1.7;">
<li>Monthly reimbursement claims</li>
<li>Internet bills</li>
<li>Other eligible expenses</li>
</ul>`;
  const intro = isThailand
    ? `Today is the <strong>22nd</strong> — please submit your monthly allowance for <strong>${escapeHtml(data.periodLabel)}</strong> in the portal.`
    : `Today is the <strong>22nd</strong> — please submit your monthly reimbursement for <strong>${escapeHtml(data.periodLabel)}</strong> in the portal.`;
  return {
    templateId: "expense-monthly-reminder",
    variables: {
      periodLabel: data.periodLabel,
      employeeName: data.employeeName,
      portalUrl: data.portalUrl,
    },
    subject,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.employeeName)}</strong>,</p>
<p style="margin:0 0 16px;">${intro}</p>
<p style="margin:0 0 10px;font-size:13px;color:${BRAND.mutedColor};">Please include:</p>
${checklist}
<p style="margin:0 0 20px;font-size:13px;color:${BRAND.mutedColor};">Create or open your report for this month, add line items with receipts where required, and submit before the finance deadline.</p>
${actionButton("Open Expenses", data.portalUrl)}
`),
  };
}

export function expenseReimbursedEmail(data: {
  employeeName: string;
  title: string;
  amount: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "expense-reimbursed",
    variables: data,
    subject: `Expense Reimbursed — ${data.title}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.employeeName)}</strong>,</p>
<p style="margin:0 0 20px;">Your expense claim has been ${statusBadge("Reimbursed", "#28a060")}.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Title:</strong> ${escapeHtml(data.title)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Amount:</strong> ${escapeHtml(data.amount)}</td></tr>
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

// ─── Survey Emails ──────────────────────────────────────

export function surveyUploadCompleteEmail(data: {
  uploaderName: string;
  waveName: string;
  responseCount: number;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "survey-upload-complete",
    variables: data,
    subject: `Survey Upload Complete — ${data.waveName}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.uploaderName)}</strong>,</p>
<p style="margin:0 0 20px;">Your survey data upload has been ${statusBadge("Completed", "#28a060")} successfully.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Wave:</strong> ${escapeHtml(data.waveName)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Responses Imported:</strong> ${data.responseCount}</td></tr>
</table>
${actionButton("View Survey Analytics", data.portalUrl)}
`),
  };
}

// ─── Sales CRM Emails ───────────────────────────────────

export function staleLeadDigestEmail(data: {
  ownerName: string;
  thresholdDays: number;
  totalCount: number;
  // Top N rows shown inline in the email; the rest are summarised by
  // count. Caller decides how many rows to surface (we recommend ≤10
  // so the email stays scannable).
  rows: {
    company: string;
    contactName: string;
    daysSinceCreated: number;
    status: string;
  }[];
  hiddenCount: number;
  portalUrl: string;
}): EmailContent {
  const rowsHtml = data.rows
    .map(
      (r) => `
<tr>
<td style="padding:10px 14px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;">
<strong>${r.company}</strong><br/>
<span style="color:${BRAND.mutedColor};font-size:12px;">${r.contactName}</span>
</td>
<td style="padding:10px 14px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;text-align:center;">${r.status}</td>
<td style="padding:10px 14px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;text-align:right;color:#c0392b;font-weight:600;">${r.daysSinceCreated}d</td>
</tr>`,
    )
    .join("");

  return {
    templateId: "stale-lead-digest-2",
    variables: {
      ownerName: data.ownerName,
      totalCount: data.totalCount,
      thresholdDays: data.thresholdDays,
      rowsHtml,
      hiddenCountHtml:
        data.hiddenCount > 0
          ? `+${data.hiddenCount} more ${data.hiddenCount === 1 ? "lead" : "leads"} hidden — open the portal to see the full list.`
          : "",
      portalUrl: data.portalUrl,
    },
    subject: `${data.totalCount} stale ${data.totalCount === 1 ? "lead needs" : "leads need"} follow-up`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.ownerName)}</strong>,</p>
<p style="margin:0 0 20px;color:${BRAND.mutedColor};">You have <strong>${data.totalCount}</strong> ${data.totalCount === 1 ? "lead" : "leads"} in <em>new</em> or <em>contacted</em> status with no activity in the last ${data.thresholdDays} days.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<thead>
<tr style="background-color:${BRAND.bgColor};">
<th align="left" style="padding:10px 14px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:${BRAND.mutedColor};border-bottom:1px solid ${BRAND.borderColor};">Lead</th>
<th align="center" style="padding:10px 14px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:${BRAND.mutedColor};border-bottom:1px solid ${BRAND.borderColor};">Status</th>
<th align="right" style="padding:10px 14px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:${BRAND.mutedColor};border-bottom:1px solid ${BRAND.borderColor};">Age</th>
</tr>
</thead>
<tbody>
${rowsHtml}
</tbody>
</table>
${data.hiddenCount > 0
    ? `<p style="margin:0 0 20px;color:${BRAND.mutedColor};font-size:12px;">+${data.hiddenCount} more ${data.hiddenCount === 1 ? "lead" : "leads"} hidden — open the portal to see the full list.</p>`
    : ""}
${actionButton("Open Stale Leads", data.portalUrl)}
`),
  };
}

// ─── Sales CRM (BD-feedback) ─────────────────────────────

export function opportunityCreatedEmail(data: {
  ownerName: string;
  accountName: string;
  opportunityName: string;
  stage: string;
  value: string;
  currency: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "opportunity-created",
    variables: data,
    subject: `New deal — ${data.accountName} · ${data.opportunityName}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">A new deal has just been added to the pipeline.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Account:</strong> ${escapeHtml(data.accountName)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Opportunity:</strong> ${escapeHtml(data.opportunityName)}</td></tr>
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Stage:</strong> ${escapeHtml(data.stage)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Value:</strong> ${escapeHtml(data.value)} ${escapeHtml(data.currency)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Owner:</strong> ${escapeHtml(data.ownerName)}</td></tr>
</table>
${actionButton("Open Pipeline", data.portalUrl)}
`),
  };
}

export function opportunityStageChangedEmail(data: {
  ownerName: string;
  accountName: string;
  opportunityName: string;
  fromStage: string;
  toStage: string;
  value: string;
  currency: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "opportunity-stage-changed",
    variables: data,
    subject: `Stage update — ${data.accountName}: ${data.fromStage} → ${data.toStage}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">A deal has moved stages.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Account:</strong> ${escapeHtml(data.accountName)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Opportunity:</strong> ${escapeHtml(data.opportunityName)}</td></tr>
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Stage:</strong> ${escapeHtml(data.fromStage)} &rarr; ${escapeHtml(data.toStage)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Value:</strong> ${escapeHtml(data.value)} ${escapeHtml(data.currency)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Owner:</strong> ${escapeHtml(data.ownerName)}</td></tr>
</table>
${actionButton("Open Pipeline", data.portalUrl)}
`),
  };
}

// ─── Allowance Filed (Expense fast-path) ───────────────────
//
// Allowance reports (e.g. Thailand Travel, Phone Bill) skip the
// manager-approval chain on submit. Two callers:
//   - `forSubmitter: true`  → confirmation to the employee
//   - `forSubmitter: false` → long-form FYI to finance-desk recipients
export function expenseAllowanceFiledEmail(data: {
  recipientName: string;
  employeeName: string;
  employeeEmail?: string;
  department?: string | null;
  entity?: string | null;
  reportTitle: string;
  amount: string;
  expenseCount: number;
  notes?: string | null;
  portalUrl: string;
  forSubmitter: boolean;
}): EmailContent {
  if (data.forSubmitter) {
    return {
      templateId: "expense-allowance-filed",
      variables: {
        reportTitle: data.reportTitle,
        recipientName: data.recipientName,
        amount: data.amount,
        expenseCount: data.expenseCount,
        portalUrl: data.portalUrl,
      },
      subject: `Allowance filed — ${data.reportTitle}`,
      html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.recipientName)}</strong>,</p>
<p style="margin:0 0 20px;">Your allowance claim has been ${statusBadge("Filed", "#28a060")}. The finance team will process the payout — no further approval is required.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Report:</strong> ${escapeHtml(data.reportTitle)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Amount:</strong> ${escapeHtml(data.amount)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Line items:</strong> ${data.expenseCount}</td></tr>
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
    };
  }
  const rows: Array<[string, string]> = [
    ["Name", data.employeeName],
    ["Email", data.employeeEmail ?? "—"],
    ["Department", data.department ?? "—"],
    ["Entity", data.entity ?? "—"],
    ["Report Title", data.reportTitle],
    ["Total Amount", data.amount],
    ["Line items", data.expenseCount.toString()],
    ["Notes", data.notes ?? ""],
  ];
  const body = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};width:42%;color:${BRAND.mutedColor};"><strong>${k}</strong></td><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  return {
    templateId: "expense-allowance-filed",
    variables: {
      reportTitle: data.reportTitle,
      recipientName: data.recipientName,
      amount: data.amount,
      expenseCount: data.expenseCount,
      portalUrl: data.portalUrl,
    },
    subject: `Allowance claim filed — ${data.employeeName}`,
    html: baseLayout(`
<p style="margin:0 0 14px;">An allowance claim has been ${statusBadge("Filed", "#28a060")}. No approval is required — please process the payout.</p>
<p style="margin:0 0 18px;font-size:13px;color:${BRAND.mutedColor};">Summary:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${body}
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

// ─── Leave Submitted (extra fan-out on create) ───────────
//
// Sent on leave submission. The submitter gets a confirmation; the
// HR-desk recipients (Sara, Pat, …) get the long-form summary so
// they're looped in before final approval, not just after.

export function leaveSubmittedConfirmationEmail(data: {
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "request-submitted-confirmation",
    variables: data,
    subject: `Leave request submitted — ${data.leaveType}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.employeeName)}</strong>,</p>
<p style="margin:0 0 20px;">Your leave request has been ${statusBadge("Submitted", "#2262F4")}. Your manager and HR have been notified.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Type:</strong> ${escapeHtml(data.leaveType)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>From:</strong> ${escapeHtml(data.startDate)} &rarr; <strong>To:</strong> ${escapeHtml(data.endDate)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Working days:</strong> ${data.days}</td></tr>
${data.reason ? `<tr><td style="padding:12px 16px;font-size:13px;"><strong>Reason:</strong> ${escapeHtml(data.reason)}</td></tr>` : ""}
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

export function leaveSubmittedDeskEmail(data: {
  employeeName: string;
  employeeEmail: string;
  department: string | null;
  entity: string | null;
  leaveType: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  portalUrl: string;
}): EmailContent {
  const rows: Array<[string, string]> = [
    ["Name", data.employeeName],
    ["Email", data.employeeEmail],
    ["Department", data.department ?? "—"],
    ["Entity", data.entity ?? "—"],
    ["Leave Type", data.leaveType],
    ["From", data.startDate],
    ["To", data.endDate],
    ["Working days", data.days.toString()],
    ["Reason", data.reason ?? ""],
  ];
  const body = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};width:42%;color:${BRAND.mutedColor};"><strong>${k}</strong></td><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  return {
    templateId: "awaiting-manager-approval",
    variables: data,
    subject: `Leave request submitted — ${data.employeeName}`,
    html: baseLayout(`
<p style="margin:0 0 14px;">A leave request has been ${statusBadge("Submitted", "#2262F4")}. Awaiting manager approval.</p>
<p style="margin:0 0 18px;font-size:13px;color:${BRAND.mutedColor};">Summary:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${body}
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

// ─── IT Helpdesk ─────────────────────────────────────────

const HELPDESK_STATUS_COLOR: Record<string, string> = {
  open: "#2262F4",
  "in-progress": "#d97706",
  review: "#d97706",
  resolved: "#28a060",
  closed: "#6b7990",
};

function helpdeskStatusBadge(status: string): string {
  return statusBadge(
    status.toUpperCase().replace(/-/g, " "),
    HELPDESK_STATUS_COLOR[status] ?? "#2262F4",
  );
}

export function helpdeskTicketCreatedTeamEmail(data: {
  ticketNumber: number;
  title: string;
  description: string;
  category: string;
  priority: string;
  creatorName: string;
  creatorEmail: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "ticketcreatedteam",
    variables: data,
    subject: `[IT-${data.ticketNumber}] New ticket — ${data.title}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">A new IT helpdesk ticket has been submitted.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Ticket:</strong> IT-${data.ticketNumber}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Title:</strong> ${escapeHtml(data.title)}</td></tr>
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Category:</strong> ${escapeHtml(data.category)} &middot; <strong>Priority:</strong> ${escapeHtml(data.priority)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Submitted by:</strong> ${escapeHtml(data.creatorName)} (${escapeHtml(data.creatorEmail)})</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;white-space:pre-wrap;"><strong>Description:</strong><br/>${escapeHtml(data.description)}</td></tr>
</table>
${actionButton("Open Ticket", data.portalUrl)}
`),
  };
}

export function helpdeskTicketCreatedRequesterEmail(data: {
  ticketNumber: number;
  title: string;
  creatorName: string;
  category: string;
  priority: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "ticket-created-requester",
    variables: data,
    subject: `[IT-${data.ticketNumber}] Ticket received — ${data.title}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.creatorName)}</strong>,</p>
<p style="margin:0 0 20px;">Your IT helpdesk ticket has been ${helpdeskStatusBadge("open")}. The IT team has been notified.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Ticket:</strong> IT-${data.ticketNumber}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Title:</strong> ${escapeHtml(data.title)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Category:</strong> ${escapeHtml(data.category)} &middot; <strong>Priority:</strong> ${escapeHtml(data.priority)}</td></tr>
</table>
${actionButton("View Ticket", data.portalUrl)}
`),
  };
}

export function helpdeskTicketStatusEmail(data: {
  ticketNumber: number;
  title: string;
  recipientName: string;
  fromStatus: string;
  toStatus: string;
  assigneeName: string | null;
  resolutionNote: string | null;
  portalUrl: string;
}): EmailContent {
  const noteRow = data.resolutionNote
    ? `<tr><td style="padding:12px 16px;font-size:13px;white-space:pre-wrap;"><strong>Resolution:</strong><br/>${escapeHtml(data.resolutionNote)}</td></tr>`
    : "";
  const assigneeRow = data.assigneeName
    ? `<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Assignee:</strong> ${escapeHtml(data.assigneeName)}</td></tr>`
    : "";
  return {
    templateId: "ticket-status-updated",
    variables: {
      ...data,
      assigneeName: data.assigneeName ?? "",
      resolutionNote: data.resolutionNote ?? "",
    },
    subject: `[IT-${data.ticketNumber}] Status: ${data.toStatus} — ${data.title}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.recipientName)}</strong>,</p>
<p style="margin:0 0 20px;">Your ticket moved from ${helpdeskStatusBadge(data.fromStatus)} to ${helpdeskStatusBadge(data.toStatus)}.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Ticket:</strong> IT-${data.ticketNumber}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Title:</strong> ${escapeHtml(data.title)}</td></tr>
${assigneeRow}
${noteRow}
</table>
${actionButton("View Ticket", data.portalUrl)}
`),
  };
}

// ─── Project Emails ──────────────────────────────────────

export function projectTaskUnblockedEmail(data: {
  completedTaskTitle: string;
  projectName: string;
  taskTitle: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "project-task-unblocked",
    variables: data,
    subject: `Unblocked — ${data.taskTitle} in ${data.projectName}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">The task <strong>${escapeHtml(data.completedTaskTitle)}</strong> has been completed.</p>
<p style="margin:0 0 20px;color:${BRAND.mutedColor};">Your task <strong>${escapeHtml(data.taskTitle)}</strong> is no longer blocked and you can proceed.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Project:</strong> ${escapeHtml(data.projectName)}</td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Blocking Task:</strong> ${escapeHtml(data.completedTaskTitle)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Your Task:</strong> ${escapeHtml(data.taskTitle)}</td></tr>
</table>
${actionButton("Open Project", data.portalUrl)}
`),
  };
}

// ─── Welcome Email ───────────────────────────────────────

export function welcomeEmail(data: {
  name: string;
  email: string;
  temporaryPassword: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "welcome-intranet",
    variables: {
      BODY: "Your intranet account has been created. Sign in with the details below.",
      name: data.name,
      portalUrl: data.portalUrl,
      email: data.email,
      temporaryPassword: data.temporaryPassword,
    },
    subject: `Welcome to ${BRAND.name} — Your Account is Ready`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hi <strong>${escapeHtml(data.name)}</strong>,</p>
<p style="margin:0 0 16px;">Here are your login credentials to access the new website.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
<tr><td style="padding:12px 16px;background-color:${BRAND.bgColor};border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Website Link:</strong> <a href="${escapeHtml(data.portalUrl)}" style="color:${BRAND.primaryColor};text-decoration:none;">${escapeHtml(data.portalUrl)}</a></td></tr>
<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>Email:</strong> ${escapeHtml(data.email)}</td></tr>
<tr><td style="padding:12px 16px;font-size:13px;"><strong>Password:</strong> <code style="background-color:${BRAND.bgColor};padding:2px 8px;border-radius:4px;font-size:14px;">${escapeHtml(data.temporaryPassword)}</code></td></tr>
</table>
<p style="margin:0 0 20px;">Please log in and let us know if you have any issues.</p>
${actionButton("Sign In to Manut", data.portalUrl)}
`),
  };
}

// ─── IT Operations Emails ────────────────────────────────
// All caller-supplied free-text (justification, access level, comments,
// product names) is escaped via escapeHtml before interpolation.

function itRow(label: string, value: string): string {
  return `<tr><td style="padding:12px 16px;border-bottom:1px solid ${BRAND.borderColor};font-size:13px;"><strong>${label}:</strong> ${value}</td></tr>`;
}

// Sent to the approver whose step an access request has reached.
export function itAccessRequestEmail(data: {
  approverName: string;
  requesterName: string;
  systemName: string;
  requestType: string;
  accessLevel: string;
  justification: string;
  stepName: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "it-access-request",
    variables: data,
    subject: `Access Request: ${data.systemName} (${data.requesterName})`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.approverName)}</strong>,</p>
<p style="margin:0 0 20px;">An access request needs your action at the <strong>${escapeHtml(data.stepName)}</strong> step.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${itRow("Requester", escapeHtml(data.requesterName))}
${itRow("System", escapeHtml(data.systemName))}
${itRow("Type", escapeHtml(data.requestType))}
${itRow("Access level", escapeHtml(data.accessLevel))}
${itRow("Justification", escapeHtml(data.justification))}
</table>
${actionButton("Review Request", data.portalUrl)}
`),
  };
}

export function itAccessDecisionEmail(data: {
  requesterName: string;
  systemName: string;
  decision: "approved" | "rejected" | "granted" | "revoked";
  byName: string;
  note?: string | null;
  portalUrl: string;
}): EmailContent {
  const map = {
    approved: { label: "Approved", color: "#16a34a" },
    granted: { label: "Granted", color: "#16a34a" },
    rejected: { label: "Rejected", color: "#dc2626" },
    revoked: { label: "Revoked", color: "#6b7990" },
  } as const;
  const b = map[data.decision];
  return {
    templateId: "it-access-decision",
    variables: { ...data, decisionLabel: b.label },
    subject: `Access ${b.label}: ${data.systemName}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.requesterName)}</strong>,</p>
<p style="margin:0 0 20px;">Your access for <strong>${escapeHtml(data.systemName)}</strong> has been ${statusBadge(b.label, b.color)} by <strong>${escapeHtml(data.byName)}</strong>.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${data.note ? itRow("Note", escapeHtml(data.note)) : itRow("System", escapeHtml(data.systemName))}
</table>
${actionButton("View in Portal", data.portalUrl)}
`),
  };
}

// Sent to a subscription owner / IT desk when a renewal or payment is due.
export function itBillingReminderEmail(data: {
  recipientName: string;
  productName: string;
  vendorName: string;
  kind: "renewal" | "payment";
  daysLeft: number;
  amount: string;
  portalUrl: string;
}): EmailContent {
  const title =
    data.kind === "renewal"
      ? `Renewal in ${data.daysLeft} day${data.daysLeft === 1 ? "" : "s"}`
      : `Payment due in ${data.daysLeft} day${data.daysLeft === 1 ? "" : "s"}`;
  return {
    templateId: "it-billing-reminder",
    variables: { ...data, title },
    subject: `${title}: ${data.productName}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.recipientName)}</strong>,</p>
<p style="margin:0 0 20px;">${statusBadge(title, "#d97706")} for an IT subscription.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${itRow("Product", escapeHtml(data.productName))}
${itRow("Vendor", escapeHtml(data.vendorName))}
${itRow("Amount", escapeHtml(data.amount))}
</table>
${actionButton("Open IT Billing", data.portalUrl)}
`),
  };
}

// CRM deadline reminder — a project go-live or a task due date approaching or
// overdue, for any CRM (`crmLabel` names it, e.g. "IT CRM" / "Integration CRM").
// Drives the `it-crm-deadline-reminder-2` remote template. The `-2` suffix is
// the OneWave replace-a-template convention (project accounts can't edit or
// delete a registered template, and re-uploading auto-suffixes the id — same
// story as cash-advance-approved-2 / visa-expiry-reminder-2): the original
// `it-crm-deadline-reminder` body hardcodes "IT CRM"; the -2 body renders
// `{{crmLabel}}`. `daysLeft` is negative when overdue.
export function crmDeadlineReminderEmail(data: {
  crmLabel: string;
  // "project" | "task" | "opportunity" — rendered as plain text in the
  // remote template; only "task" changes the row layout below.
  itemType: string;
  title: string;
  projectName: string;
  deadlineLabel: string;
  dueDate: string;
  daysLeft: number;
  portalUrl: string;
}): EmailContent {
  const abs = Math.abs(data.daysLeft);
  const plural = abs === 1 ? "" : "s";
  const headline =
    data.daysLeft < 0
      ? `Overdue by ${abs} day${plural}`
      : data.daysLeft === 0
        ? "Due today"
        : `Due in ${data.daysLeft} day${plural}`;
  const badgeColor = data.daysLeft < 0 ? "#dc2626" : "#d97706";
  const itemRow =
    data.itemType === "task"
      ? itRow("Task", escapeHtml(data.title))
      : itRow("Project", escapeHtml(data.title));
  return {
    templateId: "it-crm-deadline-reminder-2",
    variables: { ...data, headline },
    subject: `${headline}: ${data.title}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello,</p>
<p style="margin:0 0 20px;">${statusBadge(headline, badgeColor)} for a ${escapeHtml(data.crmLabel)} ${escapeHtml(data.itemType)}.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${itemRow}
${data.itemType === "task" ? itRow("Project", escapeHtml(data.projectName)) : ""}
${itRow(data.deadlineLabel, escapeHtml(data.dueDate))}
</table>
${actionButton(`Open ${escapeHtml(data.crmLabel)}`, data.portalUrl)}
`),
  };
}

// CRM task update — status change, (re)assignment, or a new comment, for any
// CRM (`crmLabel` names it). Drives the `it-crm-task-update-2` remote template
// (`-2` = the OneWave replace-a-template convention; see the deadline-reminder
// comment above — the un-suffixed original hardcodes "IT CRM").
export function crmTaskUpdateEmail(data: {
  crmLabel: string;
  taskTitle: string;
  projectName: string;
  eventLabel: string;
  summary: string;
  portalUrl: string;
}): EmailContent {
  return {
    templateId: "it-crm-task-update-2",
    variables: { ...data },
    subject: `${data.eventLabel}: ${data.taskTitle}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello,</p>
<p style="margin:0 0 20px;">${statusBadge(data.eventLabel, "#2563eb")} in ${escapeHtml(data.crmLabel)}.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">
${itRow("Task", escapeHtml(data.taskTitle))}
${itRow("Project", escapeHtml(data.projectName))}
${itRow("Update", escapeHtml(data.summary))}
</table>
${actionButton(`Open ${escapeHtml(data.crmLabel)}`, data.portalUrl)}
`),
  };
}

// ── Project approval workflow ────────────────────────────
// Every caller-supplied value is escaped: project names, requester names and
// free-text comments all reach approver inboxes, so unescaped they would
// inject HTML (see CLAUDE.md "Email HTML injection"). URLs are produced
// server-side from configuration, never from user input.

/** Notifies the next approver that a request is waiting on them. */
export function projectApprovalRequestEmail(data: {
  approverName: string;
  projectName: string;
  requesterName: string;
  priority: string;
  status: string;
  comment: string | null;
  deepLink: string;
  approveLink?: string | null;
  rejectLink?: string | null;
}): EmailContent {
  const rows = [
    ["Requester", data.requesterName],
    ["Priority", data.priority],
    ["Status", data.status],
    ["Comments", data.comment?.trim() || "—"],
  ]
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};width:32%;color:${BRAND.mutedColor};"><strong>${k}</strong></td><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};">${escapeHtml(v)}</td></tr>`,
    )
    .join("");

  // One-click approve is only rendered when signed action links are enabled.
  const actions = data.approveLink
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr>
<td style="border-radius:8px;background-color:${BRAND.primaryColor};">
<a href="${escapeHtml(data.approveLink)}" target="_blank" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;border-radius:8px;">Approve</a>
</td>
<td style="width:12px;">&nbsp;</td>
<td style="border-radius:8px;border:1px solid ${BRAND.borderColor};">
<a href="${escapeHtml(data.rejectLink ?? data.deepLink)}" target="_blank" style="display:inline-block;padding:11px 26px;color:${BRAND.textColor};text-decoration:none;font-size:14px;font-weight:600;border-radius:8px;">Reject</a>
</td></tr></table>
<p style="margin:0 0 8px;font-size:12px;color:${BRAND.mutedColor};">Rejecting opens the request so you can record a reason.</p>`
    : actionButton("Review Request", data.deepLink);

  return {
    templateId: "project-approval-request",
    variables: {
      approverName: data.approverName,
      projectName: data.projectName,
      requesterName: data.requesterName,
      priority: data.priority,
      status: data.status,
      comment: data.comment?.trim() || "—",
      deepLink: data.deepLink,
      approveLink: data.approveLink ?? "",
      rejectLink: data.rejectLink ?? "",
      // The provider renders the registered template from `variables` alone and
      // cannot branch, so the one-click / deep-link-only choice is resolved here
      // and passed as pre-rendered HTML.
      actionsHtml: actions,
    },
    subject: `Approval needed: ${data.projectName}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.approverName)}</strong>,</p>
<p style="margin:0 0 20px;color:${BRAND.mutedColor};"><strong>${escapeHtml(data.projectName)}</strong> is waiting for your approval.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:4px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">${rows}</table>
${actions}
<p style="margin:0;font-size:12px;color:${BRAND.mutedColor};">Or open it directly: <a href="${escapeHtml(data.deepLink)}" style="color:${BRAND.primaryColor};">${escapeHtml(data.projectName)}</a></p>
`),
  };
}

/** Tells the requester / owner that a decision was recorded. */
export function projectWorkflowDecisionEmail(data: {
  recipientName: string;
  projectName: string;
  requesterName: string;
  priority: string;
  status: string;
  decidedBy: string;
  approved: boolean;
  comment: string | null;
  deepLink: string;
}): EmailContent {
  const rows = [
    ["Requester", data.requesterName],
    ["Priority", data.priority],
    ["Status", data.status],
    [data.approved ? "Approved by" : "Rejected by", data.decidedBy],
    [data.approved ? "Comments" : "Reason", data.comment?.trim() || "—"],
  ]
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};width:32%;color:${BRAND.mutedColor};"><strong>${k}</strong></td><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};">${escapeHtml(v)}</td></tr>`,
    )
    .join("");

  return {
    templateId: "project-workflow-decision",
    variables: {
      recipientName: data.recipientName,
      projectName: data.projectName,
      requesterName: data.requesterName,
      priority: data.priority,
      status: data.status,
      decidedBy: data.decidedBy,
      comment: data.comment?.trim() || "—",
      deepLink: data.deepLink,
      // Row labels vary with the outcome. The provider cannot evaluate
      // `approved`, so resolve both labels here.
      decidedByLabel: data.approved ? "Approved by" : "Rejected by",
      commentLabel: data.approved ? "Comments" : "Reason",
    },
    subject: `${data.projectName} — ${data.status}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.recipientName)}</strong>,</p>
<p style="margin:0 0 20px;color:${BRAND.mutedColor};"><strong>${escapeHtml(data.projectName)}</strong> is now <strong>${escapeHtml(data.status)}</strong>.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">${rows}</table>
${actionButton("View Request", data.deepLink)}
`),
  };
}

// ── Product proposals ────────────────────────────────────
// Every caller-supplied value is escaped. Titles, questions, answers and decline
// reasons all reach inboxes, so unescaped they would inject HTML (see CLAUDE.md
// "Email HTML injection"). URLs are built server-side from configuration, never
// from user input.

/** Rows of label/value pairs, values escaped. */
function proposalRows(pairs: Array<[string, string | null]>): string {
  return pairs
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};width:32%;color:${BRAND.mutedColor};"><strong>${k}</strong></td><td style="padding:6px 16px;font-size:13px;border-bottom:1px solid ${BRAND.borderColor};">${escapeHtml(v?.trim() || "—")}</td></tr>`,
    )
    .join("");
}

/**
 * Something needs this person's attention on a proposal: it has been submitted
 * to them, or they have been asked a question.
 */
export function proposalActionEmail(data: {
  recipientName: string;
  headline: string;
  proposalTitle: string;
  proposalType: string;
  raisedBy: string;
  priority: string;
  status: string;
  /** The question, when this is an information request. */
  question?: string | null;
  deepLink: string;
  callToAction: string;
}): EmailContent {
  const rows = proposalRows([
    ["Type", data.proposalType],
    ["Raised by", data.raisedBy],
    ["Priority", data.priority],
    ["Status", data.status],
  ]);

  const questionBlock = data.question
    ? `<p style="margin:0 0 6px;font-size:13px;color:${BRAND.mutedColor};">What is being asked:</p>
<blockquote style="margin:0 0 20px;padding:10px 14px;border-left:3px solid ${BRAND.primaryColor};background-color:#faf9f7;font-size:13px;">${escapeHtml(data.question)}</blockquote>`
    : "";

  return {
    templateId: "proposal-action",
    variables: {
      recipientName: data.recipientName,
      headline: data.headline,
      proposalTitle: data.proposalTitle,
      proposalType: data.proposalType,
      raisedBy: data.raisedBy,
      priority: data.priority,
      status: data.status,
      question: data.question ?? "",
      deepLink: data.deepLink,
      // Both the button label and the optional question block have to reach the
      // provider explicitly: it substitutes `variables` and cannot branch.
      callToAction: data.callToAction,
      questionBlockHtml: questionBlock,
    },
    subject: `${data.headline}: ${data.proposalTitle}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.recipientName)}</strong>,</p>
<p style="margin:0 0 20px;color:${BRAND.mutedColor};">${escapeHtml(data.headline)} — <strong>${escapeHtml(data.proposalTitle)}</strong>.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">${rows}</table>
${questionBlock}
${actionButton(data.callToAction, data.deepLink)}
`),
  };
}

/**
 * Something has been recorded on a proposal: a decision, or an answer arriving.
 * Informational, so it carries the outcome rather than asking for anything.
 */
export function proposalUpdateEmail(data: {
  recipientName: string;
  headline: string;
  proposalTitle: string;
  status: string;
  actedBy: string;
  /** The decline reason, the pass note, or the answer text. */
  detail?: string | null;
  detailLabel?: string;
  deepLink: string;
}): EmailContent {
  const rows = proposalRows([
    ["Proposal", data.proposalTitle],
    ["Status", data.status],
    ["By", data.actedBy],
  ]);

  const detailBlock = data.detail?.trim()
    ? `<p style="margin:0 0 6px;font-size:13px;color:${BRAND.mutedColor};">${escapeHtml(data.detailLabel ?? "Notes")}:</p>
<blockquote style="margin:0 0 20px;padding:10px 14px;border-left:3px solid ${BRAND.borderColor};background-color:#faf9f7;font-size:13px;">${escapeHtml(data.detail)}</blockquote>`
    : "";

  return {
    templateId: "proposal-update",
    variables: {
      recipientName: data.recipientName,
      headline: data.headline,
      proposalTitle: data.proposalTitle,
      status: data.status,
      actedBy: data.actedBy,
      detail: data.detail ?? "",
      deepLink: data.deepLink,
      // Carries its own "Answer" / "Reason" / "Notes" heading, and is empty when
      // there is no detail — so the provider never renders a stray heading.
      detailBlockHtml: detailBlock,
    },
    subject: `${data.headline}: ${data.proposalTitle}`,
    html: baseLayout(`
<p style="margin:0 0 6px;">Hello <strong>${escapeHtml(data.recipientName)}</strong>,</p>
<p style="margin:0 0 20px;color:${BRAND.mutedColor};">${escapeHtml(data.headline)}.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;border:1px solid ${BRAND.borderColor};border-radius:8px;overflow:hidden;">${rows}</table>
${detailBlock}
${actionButton("View Proposal", data.deepLink)}
`),
  };
}
