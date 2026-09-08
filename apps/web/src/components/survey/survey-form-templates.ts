import type { QuestionInput } from "@/services/survey.service";

export interface SurveyTemplate {
  id: string;
  label: string;
  description: string;
  title: string;
  formDescription: string;
  isAnonymous: boolean;
  questions: QuestionInput[];
}

const COMPANY_VALUES = [
  "Integrity",
  "Collaboration",
  "Excellence",
  "Innovation",
  "Accountability",
  "Other",
] as const;

/** Go the Extra Mile Award — employee recognition nomination form. */
export const GO_EXTRA_MILE_AWARD_TEMPLATE: SurveyTemplate = {
  id: "go-extra-mile-award",
  label: "Go the Extra Mile Award — Nomination",
  description:
    "Employee recognition nomination with nominee details, narrative questions, values checkboxes, and optional impact ratings.",
  title: "Go the Extra Mile Award — Nomination Form",
  formDescription: `The Go the Extra Mile Award celebrates colleagues who go above and beyond their everyday responsibilities — those who step up, lift others, and deliver something exceptional. Anyone at Manut can nominate a colleague.

Award criteria — a strong nominee demonstrates one or more of the following:
• Went beyond their normal role to help a colleague, customer, or team.
• Solved a difficult problem with initiative, creativity, or persistence.
• Made a measurable, positive impact on the business or a customer.
• Embodied our values in how the work was done — not just what was achieved.
• Inspired or supported others through their effort, attitude, or leadership.

Our values: Integrity · Collaboration · Excellence · Innovation · Accountability`,
  isAnonymous: false,
  questions: [
    {
      type: "info",
      prompt: "Nominee details",
      helperText: "The colleague you are nominating.",
      required: false,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Nominee name",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Nominee job title",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Nominee department / team",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Nominee line manager",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "info",
      prompt: "Your details (nominator)",
      helperText: "Tell us who is submitting this nomination.",
      required: false,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Your name",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Your job title",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Your department / team",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Your email address",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "date",
      prompt: "Date of nomination",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "info",
      prompt: "The nomination",
      helperText:
        "This is the most important part. Be specific — real examples make the strongest case.",
      required: false,
      options: [],
      settings: {},
    },
    {
      type: "long_text",
      prompt:
        "1. What did this person do? Describe the situation and the action they took.",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "long_text",
      prompt:
        "2. Why did it go above and beyond? What made this exceptional rather than business as usual?",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "long_text",
      prompt:
        "3. What was the impact? Describe the outcome for the customer, team, or business (include results where you can).",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "info",
      prompt: "Values demonstrated",
      helperText: "Tick the value(s) this nominee best demonstrated.",
      required: false,
      options: [],
      settings: {},
    },
    {
      type: "multi_choice",
      prompt: "Which values did this nominee demonstrate?",
      helperText: "Select all that apply.",
      required: true,
      options: [...COMPANY_VALUES],
      settings: {},
    },
    {
      type: "short_text",
      prompt: 'If you ticked "Other", please specify',
      helperText: null,
      required: false,
      options: [],
      settings: {},
    },
    {
      type: "info",
      prompt: "Optional: rate the impact",
      helperText:
        "For the selection panel. 1 = met expectations, 5 = truly exceptional.",
      required: false,
      options: [],
      settings: {},
    },
    {
      type: "rating",
      prompt: "Effort beyond the role",
      helperText: "1 = met expectations · 5 = truly exceptional",
      required: false,
      options: [],
      settings: { min: 1, max: 5 },
    },
    {
      type: "rating",
      prompt: "Impact on team / customer / business",
      helperText: "1 = met expectations · 5 = truly exceptional",
      required: false,
      options: [],
      settings: { min: 1, max: 5 },
    },
    {
      type: "rating",
      prompt: "Alignment with our values",
      helperText: "1 = met expectations · 5 = truly exceptional",
      required: false,
      options: [],
      settings: { min: 1, max: 5 },
    },
    {
      type: "rating",
      prompt: "Inspired or supported others",
      helperText: "1 = met expectations · 5 = truly exceptional",
      required: false,
      options: [],
      settings: { min: 1, max: 5 },
    },
  ],
};

/** Kudo Awards — peer recognition nomination form. */
export const KUDO_AWARDS_TEMPLATE: SurveyTemplate = {
  id: "kudo-awards",
  label: "Kudo Awards — Nomination",
  description:
    "Peer recognition nomination with nominee details, award category, narrative questions, and optional bonus factors.",
  title: "🏆 Kudo Awards — Nomination Form",
  formDescription: `Recognise a colleague whose work deserves to be seen, valued and rewarded. Anyone can nominate anyone — cross-department nominations are actively encouraged.

Eligibility: full-time employees, 3+ months of service. The review panel scores on impact, category fit, values and sustained effort — so be specific.`,
  isAnonymous: false,
  questions: [
    {
      type: "info",
      prompt: "Who are you recognising?",
      helperText: "The colleague you are nominating.",
      required: false,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Nominee name",
      helperText: "Full name of the person you're recognising.",
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Department",
      helperText: "Their team or department.",
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Role / title",
      helperText: "Optional.",
      required: false,
      options: [],
      settings: {},
    },
    {
      type: "single_choice",
      prompt: "Award category",
      helperText: "Tick one.",
      required: true,
      options: [
        "💡 Initiative — spotted a problem or opportunity and took action without being asked",
        "🤝 Collaboration — brought teams together and lived our one-company culture",
      ],
      settings: {},
    },
    {
      type: "info",
      prompt: "Your nomination",
      helperText:
        "Be specific — the panel scores on impact, category fit, values and sustained effort.",
      required: false,
      options: [],
      settings: {},
    },
    {
      type: "long_text",
      prompt: "What did they do?",
      helperText:
        "Describe the specific achievement or contribution — be concrete, not general praise.",
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "long_text",
      prompt: "What was the impact?",
      helperText:
        "Measurable or observable results — for the team, a customer, or the company.",
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "long_text",
      prompt: "Why this category?",
      helperText: "Briefly, how their actions fit Initiative or Collaboration.",
      required: false,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Over what period?",
      helperText:
        "A sustained effort over time, or an exceptional one-off act?",
      required: false,
      options: [],
      settings: {},
    },
    {
      type: "info",
      prompt: "Bonus factors (optional)",
      helperText: "These can earn extra credit but aren't required.",
      required: false,
      options: [],
      settings: {},
    },
    {
      type: "multi_choice",
      prompt: "Bonus factors",
      helperText: "Select any that apply.",
      required: false,
      options: [
        "Cross-department impact — positive effect beyond their own team",
        "Peer endorsement — other colleagues would back this nomination",
      ],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Supporting colleagues",
      helperText: "Optional — names of others who'd endorse this.",
      required: false,
      options: [],
      settings: {},
    },
    {
      type: "info",
      prompt: "About you",
      helperText: "Tell us who is submitting this nomination.",
      required: false,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Your name",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "Your department",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "date",
      prompt: "Date",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
  ],
};

/** Training Course Survey — collect course/training requests from staff. */
export const TRAINING_COURSE_SURVEY_TEMPLATE: SurveyTemplate = {
  id: "training-course-survey",
  label: "Training Course Survey",
  description:
    "Collect training/course requests from staff — name, department, desired course, and how it helps them + the company.",
  title: "Training Course Survey",
  formDescription: `Tell us what you'd like to learn — it takes 2 minutes.

We're planning training for the year ahead and want to invest in courses that genuinely help you and the business. Please tell us the course you'd like to take and how it would make a difference. Deadline: [insert date].`,
  isAnonymous: false,
  questions: [
    {
      type: "short_text",
      prompt: "What is your name?",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "What is your department?",
      helperText: null,
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "short_text",
      prompt: "What course or training would you like to take?",
      helperText: "Course name or topic.",
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "long_text",
      prompt: "How would this help you in your job?",
      helperText: "A sentence or two.",
      required: true,
      options: [],
      settings: {},
    },
    {
      type: "long_text",
      prompt: "How would this benefit the company?",
      helperText: "A sentence or two.",
      required: true,
      options: [],
      settings: {},
    },
  ],
};

export const SURVEY_TEMPLATES: SurveyTemplate[] = [
  GO_EXTRA_MILE_AWARD_TEMPLATE,
  KUDO_AWARDS_TEMPLATE,
  TRAINING_COURSE_SURVEY_TEMPLATE,
];

export function getSurveyTemplate(id: string): SurveyTemplate | undefined {
  return SURVEY_TEMPLATES.find((t) => t.id === id);
}

/** Prefill nominator fields when the signed-in user opens a nomination form. */
export function buildSurveyRespondentPrefill(
  questions: Array<{ id: string; type: string; prompt: string }>,
  user: {
    name: string;
    email: string;
    department?: string | null;
    jobTitle?: string | null;
  } | null,
): Record<string, unknown> {
  if (!user) return {};
  const byPrompt: Record<string, string> = {
    "Your name": user.name,
    "Your email address": user.email,
    "Your department / team": user.department ?? "",
    "Your job title": user.jobTitle ?? "",
  };
  const out: Record<string, unknown> = {};
  const today = new Date().toISOString().slice(0, 10);
  for (const q of questions) {
    if (q.type === "info") continue;
    if (q.prompt === "Date of nomination") out[q.id] = today;
    const text = byPrompt[q.prompt];
    if (text) out[q.id] = text;
  }
  return out;
}
