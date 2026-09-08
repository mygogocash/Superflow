import { ASSISTANT_DISPLAY_NAME } from "@/lib/brand";

export type ManutAiPreset = {
  id: string;
  label: string;
  prompt: string;
};

/** Starter prompts for the Expo Manut AI empty state (subset of web presets). */
export const MANUT_AI_PRESETS: readonly ManutAiPreset[] = [
  {
    id: "leave-balance",
    label: "Leave balance",
    prompt: "What is my current leave balance, and are there any pending requests I should know about?",
  },
  {
    id: "today",
    label: "What's on today",
    prompt: "Summarise what I should focus on today across my open tasks, leave, and approvals.",
  },
  {
    id: "expenses",
    label: "Expense status",
    prompt: "Show my recent expense reports and anything waiting on my approval or reimbursement.",
  },
  {
    id: "policies",
    label: "HR policies",
    prompt: "Point me to the leave and travel policy highlights that apply to employees in my entity.",
  },
];

export const MANUT_AI_GREETING = `Ask ${ASSISTANT_DISPLAY_NAME} about leave, expenses, policies, and your workspace.`;
