"use client";

import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/shared/badge";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/providers/auth-provider";
import {
  ARIA_KNOWLEDGE_CATEGORIES,
  ARIA_KNOWLEDGE_CATEGORY_LABELS,
  type AriaKnowledgeArticle,
  type AriaKnowledgeCategory,
  createAriaKnowledge,
  deleteAriaKnowledge,
  listAriaKnowledge,
  updateAriaKnowledge,
} from "@/services/aria-knowledge.service";

interface FormState {
  id: string | null;
  category: AriaKnowledgeCategory;
  title: string;
  slug: string;
  body: string;
  keywords: string;
  tags: string;
  // Comma-separated permission codes. Empty string = public.
  requiredPermissions: string;
  isActive: boolean;
}

const EMPTY_FORM: FormState = {
  id: null,
  category: "immigration",
  title: "",
  slug: "",
  body: "",
  keywords: "",
  tags: "",
  requiredPermissions: "",
  isActive: true,
};

function articleToForm(a: AriaKnowledgeArticle): FormState {
  return {
    id: a.id,
    category: a.category,
    title: a.title,
    slug: a.slug,
    body: a.body,
    keywords: a.keywords.join(", "),
    tags: a.tags.join(", "),
    requiredPermissions: (a.requiredPermissions ?? []).join(", "),
    isActive: a.isActive,
  };
}

function csvToArr(csv: string): string[] {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
}

export default function AriaKnowledgeAdminPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("aria:knowledge-manage");

  const [articles, setArticles] = useState<AriaKnowledgeArticle[]>([]);
  const [loading, setLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [filter, setFilter] = useState<AriaKnowledgeCategory | "all">("all");

  const refresh = useCallback(async () => {
    if (!canManage) return;
    try {
      setLoading(true);
      const res = await listAriaKnowledge(
        filter === "all" ? {} : { category: filter },
      );
      setArticles(res.data);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [canManage, filter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  }

  function openEdit(a: AriaKnowledgeArticle) {
    setForm(articleToForm(a));
    setEditorOpen(true);
  }

  async function handleSubmit() {
    try {
      setSubmitting(true);
      const payload = {
        category: form.category,
        title: form.title.trim(),
        slug: form.slug
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-{2,}/g, "-"),
        body: form.body.trim(),
        keywords: csvToArr(form.keywords),
        tags: csvToArr(form.tags),
        requiredPermissions: csvToArr(form.requiredPermissions),
        isActive: form.isActive,
      };
      if (form.id) {
        await updateAriaKnowledge(form.id, payload);
        toast.success("Article updated");
      } else {
        await createAriaKnowledge(payload);
        toast.success("Article created");
      }
      setEditorOpen(false);
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(a: AriaKnowledgeArticle) {
    if (!confirm(`Delete "${a.title}"?`)) return;
    try {
      await deleteAriaKnowledge(a.id);
      toast.success("Deleted");
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed");
    }
  }

  if (!canManage) {
    return (
      <div className="text-muted-foreground p-8 text-sm">
        You don&apos;t have permission to manage the Manut AI knowledge corpus.
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Manut AI knowledge"
        subtitle="Curated articles surfaced into Manut AI chat answers via keyword retrieval"
      >
        <Button onClick={openCreate}>
          <Plus className="size-3.5" />
          New article
        </Button>
      </PageHeader>

      <div
        className={`
          border-border bg-surface mb-4 flex items-center gap-2 rounded-lg
          border p-3 shadow-sm
        `}
      >
        <Label className="text-muted-foreground text-[11px]">Filter</Label>
        <Select
          value={filter}
          onValueChange={(v) => setFilter(v as typeof filter)}
        >
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {ARIA_KNOWLEDGE_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {ARIA_KNOWLEDGE_CATEGORY_LABELS[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground ml-auto text-xs">
          {articles.length} article{articles.length === 1 ? "" : "s"}
        </span>
      </div>

      {loading ? (
        <div
          className={`
            text-muted-foreground flex items-center justify-center gap-2 py-12
            text-xs
          `}
        >
          <Loader2 className="size-3.5 animate-spin" />
          Loading…
        </div>
      ) : articles.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-xs">
          No articles yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {articles.map((a) => (
            <li
              key={a.id}
              className={`
                border-border bg-surface flex flex-col gap-2 rounded-lg border
                p-4 shadow-sm
              `}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="grey">
                      {ARIA_KNOWLEDGE_CATEGORY_LABELS[a.category]}
                    </Badge>
                    {!a.isActive && <Badge variant="amber">Inactive</Badge>}
                    <p className="text-foreground text-sm font-semibold">
                      {a.title}
                    </p>
                  </div>
                  <p
                    className={`
                      text-muted-foreground mt-1 line-clamp-2 text-xs
                      whitespace-pre-line
                    `}
                  >
                    {a.body.slice(0, 200)}
                    {a.body.length > 200 ? "…" : ""}
                  </p>
                  <p className="text-muted-foreground mt-2 text-[10px]">
                    /{a.slug} · keywords: {a.keywords.join(", ") || "—"}
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => openEdit(a)}
                    aria-label="Edit"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void handleDelete(a)}
                    aria-label="Delete"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent
          className={`
            max-h-[92vh] overflow-y-auto
            sm:max-w-2xl
          `}
        >
          <DialogHeader>
            <DialogTitle>
              {form.id ? "Edit article" : "New article"}
            </DialogTitle>
            <DialogDescription>
              Manut AI prepends the matching article body to its chat system prompt.
              Keep titles + bodies focused so the model has clean context.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Category *</Label>
                <Select
                  value={form.category}
                  onValueChange={(v) =>
                    setForm({ ...form, category: v as AriaKnowledgeCategory })
                  }
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ARIA_KNOWLEDGE_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {ARIA_KNOWLEDGE_CATEGORY_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Slug *</Label>
                <Input
                  value={form.slug}
                  onChange={(e) => setForm({ ...form, slug: e.target.value })}
                  placeholder="lowercase-with-hyphens"
                  className="mt-1"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Title *</Label>
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Body *</Label>
              <Textarea
                rows={10}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                placeholder="Markdown-ish text. Manut AI prepends this verbatim into its chat system prompt when keywords match the user's question."
                className="mt-1 font-mono text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Keywords (comma-separated)</Label>
                <Input
                  value={form.keywords}
                  onChange={(e) =>
                    setForm({ ...form, keywords: e.target.value })
                  }
                  placeholder="90-day report, tm47, residence notification"
                  className="mt-1"
                />
                <p className="text-muted-foreground mt-1 text-[10px]">
                  Lowercase phrases that trigger this article. Longer phrases
                  outrank shorter ones.
                </p>
              </div>
              <div>
                <Label className="text-xs">Tags (comma-separated)</Label>
                <Input
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  placeholder="thailand, immigration"
                  className="mt-1"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">
                Required permissions (comma-separated)
              </Label>
              <Input
                value={form.requiredPermissions}
                onChange={(e) =>
                  setForm({ ...form, requiredPermissions: e.target.value })
                }
                placeholder="payroll:read, hr-admin:read"
                className="mt-1"
              />
              <p className="text-muted-foreground mt-1 text-[10px]">
                Leave empty for an article every signed-in user can see. Add
                codes (e.g. <code>payroll:read</code>, <code>visa:hr-read</code>
                ) to gate it: the caller must hold AT LEAST ONE of these codes
                for Manut AI to surface the article in chat. Codes are free strings
                — admins can reference future permissions without redeploying.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={form.isActive}
                onCheckedChange={(v) => setForm({ ...form, isActive: v })}
              />
              <Label className="text-xs">Active (used in retrieval)</Label>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditorOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting || !form.title || !form.slug || !form.body}
            >
              {submitting && <Loader2 className="mr-2 size-3.5 animate-spin" />}
              {form.id ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
