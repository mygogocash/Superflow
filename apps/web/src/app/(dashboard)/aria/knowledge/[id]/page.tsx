"use client";

import { ArrowLeft, BookOpen, Tag } from "lucide-react";
import { useParams } from "next/navigation";
import { useRouter } from "nextjs-toploader/app";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/shared/badge";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api-client";
import {
  ARIA_KNOWLEDGE_CATEGORY_LABELS,
  getAriaKnowledge,
  type ManutAiKnowledgeArticle,
} from "@/services/aria-knowledge.service";

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function ManutAiKnowledgeArticlePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = typeof params?.id === "string" ? params.id : "";

  const [article, setArticle] = useState<ManutAiKnowledgeArticle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getAriaKnowledge(id)
      .then((res) => {
        if (!cancelled) setArticle(res.data);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg =
          err instanceof ApiError ? err.message : "Failed to load article";
        setError(msg);
        toast.error(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-64 w-full rounded-md" />
      </div>
    );
  }

  if (error || !article) {
    return (
      <div className="flex min-h-96 flex-col items-center justify-center gap-4">
        <BookOpen className="text-muted-foreground size-10" />
        <p className="text-foreground text-base font-medium">
          {error ?? "Article not found"}
        </p>
        <p className="text-muted-foreground max-w-md text-center text-sm">
          The article may have been removed, or you may not have permission to
          view it.
        </p>
        <Button variant="outline" onClick={() => router.back()}>
          <ArrowLeft className="mr-2 size-4" /> Back
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={article.title}
        subtitle={
          ARIA_KNOWLEDGE_CATEGORY_LABELS[article.category] ?? article.category
        }
      >
        <Button variant="ghost" onClick={() => router.back()}>
          <ArrowLeft className="size-3.5" /> Back
        </Button>
        {!article.isActive && <Badge status="inactive">Inactive</Badge>}
      </PageHeader>

      <section
        className={`
          border-border bg-surface flex flex-wrap items-center gap-x-4 gap-y-2
          rounded-lg border px-4 py-3 text-xs shadow-sm
        `}
      >
        <span className="text-muted-foreground">
          <span className="text-foreground/80 font-medium">Updated</span>{" "}
          {formatDate(article.updatedAt)}
        </span>
        {article.createdBy && (
          <span className="text-muted-foreground">
            <span className="text-foreground/80 font-medium">Created by</span>{" "}
            {article.createdBy.name}
          </span>
        )}
        {article.tags.length > 0 && (
          <span
            className={`text-muted-foreground inline-flex items-center gap-1.5`}
          >
            <Tag className="size-3" />
            {article.tags.map((t) => (
              <span
                key={t}
                className={`
                  border-border bg-muted/40 rounded-full border px-2 py-0.5
                  text-[10px]
                `}
              >
                {t}
              </span>
            ))}
          </span>
        )}
      </section>

      <article
        className={`
          border-border bg-surface prose prose-sm max-w-none rounded-lg border
          p-6 shadow-sm
          dark:prose-invert
        `}
      >
        {/* Knowledge articles are stored as plain text / markdown-ish
            body. Render as preformatted to preserve newlines until a
            proper markdown renderer is wired in (TipTap is heavier than
            we want for read-only views). */}
        <pre
          className={`
            text-foreground bg-transparent p-0 font-sans text-sm
            whitespace-pre-wrap
          `}
        >
          {article.body}
        </pre>
      </article>

      {article.keywords.length > 0 && (
        <section className="text-muted-foreground text-xs">
          <span className="text-foreground/80 font-medium">Keywords:</span>{" "}
          {article.keywords.join(", ")}
        </section>
      )}
    </div>
  );
}
