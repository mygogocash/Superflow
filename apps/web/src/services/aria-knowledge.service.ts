import { api } from "@/lib/api-client";
import type { ApiSuccessResponse } from "@/types/api.type";

export const ARIA_KNOWLEDGE_CATEGORIES = [
  "immigration",
  "hr",
  "finance",
  "policy",
  "other",
] as const;

export type AriaKnowledgeCategory = (typeof ARIA_KNOWLEDGE_CATEGORIES)[number];

export const ARIA_KNOWLEDGE_CATEGORY_LABELS: Record<
  AriaKnowledgeCategory,
  string
> = {
  immigration: "Immigration",
  hr: "HR",
  finance: "Finance",
  policy: "Policy",
  other: "Other",
};

export interface ManutAiKnowledgeArticle {
  id: string;
  category: AriaKnowledgeCategory;
  title: string;
  slug: string;
  body: string;
  keywords: string[];
  tags: string[];
  /**
   * Permission codes that gate retrieval. Empty list = public to any
   * signed-in user; non-empty = caller must hold at least one of the
   * listed codes (OR semantics).
   */
  requiredPermissions: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: { id: string; name: string; email: string } | null;
}

export interface AriaKnowledgeListParams {
  category?: AriaKnowledgeCategory;
  isActive?: boolean;
  search?: string;
}

export interface AriaKnowledgeInput {
  category: AriaKnowledgeCategory;
  title: string;
  slug: string;
  body: string;
  keywords: string[];
  tags: string[];
  requiredPermissions: string[];
  isActive: boolean;
}

function buildQuery(params: AriaKnowledgeListParams): string {
  const qs = new URLSearchParams();
  if (params.category) qs.set("category", params.category);
  if (params.isActive !== undefined) {
    qs.set("isActive", String(params.isActive));
  }
  if (params.search) qs.set("search", params.search);
  const str = qs.toString();
  return str ? `?${str}` : "";
}

export async function listAriaKnowledge(
  params: AriaKnowledgeListParams = {},
): Promise<ApiSuccessResponse<ManutAiKnowledgeArticle[]>> {
  return api.get(`/aria/knowledge${buildQuery(params)}`);
}

export async function getAriaKnowledge(
  id: string,
): Promise<ApiSuccessResponse<ManutAiKnowledgeArticle>> {
  return api.get(`/aria/knowledge/${id}`);
}

export async function createAriaKnowledge(
  input: AriaKnowledgeInput,
): Promise<ApiSuccessResponse<ManutAiKnowledgeArticle>> {
  return api.post("/aria/knowledge", input);
}

export async function updateAriaKnowledge(
  id: string,
  input: Partial<AriaKnowledgeInput>,
): Promise<ApiSuccessResponse<ManutAiKnowledgeArticle>> {
  return api.put(`/aria/knowledge/${id}`, input);
}

export async function deleteAriaKnowledge(id: string): Promise<void> {
  await api.delete(`/aria/knowledge/${id}`);
}
