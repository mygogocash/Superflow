"use client";

import { DatabaseZap, Loader2, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/providers/auth-provider";
import {
  type AriaImprovementItem,
  type AriaInsights,
  draftArticleFromFeedback,
  getAriaInsights,
  listAriaImprovementQueue,
  reviewAriaFeedback,
  runAriaKnowledgeSync,
} from "@/services/aria.service";

const WINDOW_OPTIONS = [
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value)} ms`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export default function AriaInsightsPage() {
  const { hasPermission } = useAuth();
  const canView = hasPermission("aria:knowledge-manage");

  const [days, setDays] = useState<number>(7);
  const [data, setData] = useState<AriaInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [queue, setQueue] = useState<AriaImprovementItem[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [draftingId, setDraftingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const insights = await getAriaInsights(days);
      setData(insights);
    } catch {
      toast.error("Failed to load Manut AI insights");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    if (canView) {
      void load();
    } else {
      setLoading(false);
    }
  }, [canView, load]);

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      const rows = await listAriaImprovementQueue();
      setQueue(rows);
    } catch {
      toast.error("Failed to load improvement queue");
    } finally {
      setQueueLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canView) void loadQueue();
  }, [canView, loadQueue]);

  const handleDraft = useCallback(async (feedbackId: string) => {
    setDraftingId(feedbackId);
    try {
      const result = await draftArticleFromFeedback(feedbackId);
      const blob = new Blob([JSON.stringify(result.draft, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `aria-draft-${result.draft.slug || feedbackId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(
        "Draft downloaded — review then paste into /admin/aria-knowledge.",
      );
    } catch {
      toast.error("Could not draft an article");
    } finally {
      setDraftingId(null);
    }
  }, []);

  const handleDismiss = useCallback(async (feedbackId: string) => {
    try {
      await reviewAriaFeedback(feedbackId, { reviewNote: "Dismissed" });
      setQueue((prev) => prev.filter((q) => q.id !== feedbackId));
      toast.success("Feedback dismissed");
    } catch {
      toast.error("Failed to dismiss");
    }
  }, []);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const report = await runAriaKnowledgeSync();
      const totalUpserted = report.perSource.reduce(
        (n, s) => n + s.upserted,
        0,
      );
      const totalDeactivated = report.perSource.reduce(
        (n, s) => n + s.deactivated,
        0,
      );
      if (report.errors.length > 0) {
        toast.warning(
          `Sync finished with ${report.errors.length} source error${
            report.errors.length === 1 ? "" : "s"
          } — ${totalUpserted} upserted.`,
        );
      } else {
        toast.success(
          `Synced ${totalUpserted} articles (${totalDeactivated} deactivated).`,
        );
      }
    } catch {
      toast.error("Knowledge sync failed");
    } finally {
      setSyncing(false);
    }
  }, []);

  if (!canView) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Manut AI Insights"
          subtitle="Telemetry from the Manut AI assistant"
        />
        <Card>
          <CardContent
            className={`text-muted-foreground py-12 text-center text-sm`}
          >
            You do not have permission to view Manut AI insights.
          </CardContent>
        </Card>
      </div>
    );
  }

  const cacheTotal =
    (data?.tokens.cacheRead ?? 0) + (data?.tokens.cacheCreate ?? 0);
  const cacheHitRatio =
    cacheTotal > 0 ? (data?.tokens.cacheRead ?? 0) / cacheTotal : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Manut AI Insights"
        subtitle="Per-turn telemetry — retrieval hit-rate, latency, and token spend."
      />

      <div className="flex items-center gap-3">
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOW_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCcw className="size-4" />
          )}
          Refresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleSync}
          disabled={syncing}
        >
          {syncing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <DatabaseZap className="size-4" />
          )}
          Run knowledge sync
        </Button>
      </div>

      {loading && !data ? (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="text-muted-foreground size-6 animate-spin" />
          </CardContent>
        </Card>
      ) : data ? (
        <>
          <div
            className={`
              grid gap-3
              sm:grid-cols-2
              lg:grid-cols-4
            `}
          >
            <Card>
              <CardHeader>
                <CardDescription>Conversations turns</CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(data.total)}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground text-xs">
                Since {new Date(data.since).toLocaleDateString()}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Retrieval hit rate</CardDescription>
                <CardTitle className="text-2xl">
                  {formatPercent(data.hitRate)}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground text-xs">
                {formatNumber(data.withHits)} / {formatNumber(data.total)} turns
                surfaced a knowledge article
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Latency p50 / p95</CardDescription>
                <CardTitle className="text-2xl">
                  {formatMs(data.latency.p50)} /{" "}
                  <span className="text-muted-foreground text-base">
                    {formatMs(data.latency.p95)}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground text-xs">
                Avg {formatMs(data.latency.avg)}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Error rate</CardDescription>
                <CardTitle className="text-2xl">
                  {formatPercent(data.errorRate)}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground text-xs">
                {formatNumber(data.errors)} errored turns
              </CardContent>
            </Card>
          </div>

          <div
            className={`
              grid gap-3
              sm:grid-cols-2
              lg:grid-cols-4
            `}
          >
            <Card>
              <CardHeader>
                <CardDescription>Tokens in</CardDescription>
                <CardTitle className="text-xl">
                  {formatNumber(data.tokens.in)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Tokens out</CardDescription>
                <CardTitle className="text-xl">
                  {formatNumber(data.tokens.out)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Cache read</CardDescription>
                <CardTitle className="text-xl">
                  {formatNumber(data.tokens.cacheRead)}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground text-xs">
                {cacheHitRatio === null
                  ? "—"
                  : `${(cacheHitRatio * 100).toFixed(1)}% of cacheable input`}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Cache create</CardDescription>
                <CardTitle className="text-xl">
                  {formatNumber(data.tokens.cacheCreate)}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Retrieval mode breakdown
              </CardTitle>
              <CardDescription>
                Where each turn pulled context from.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.retrievalModes.length === 0 ? (
                <p className="text-muted-foreground text-sm">No data.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground text-left text-xs">
                      <th className="pb-2 font-medium">Mode</th>
                      <th className="pb-2 text-right font-medium">Turns</th>
                      <th className="pb-2 text-right font-medium">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.retrievalModes.map((m) => (
                      <tr key={m.mode} className="border-border border-t">
                        <td className="py-1.5">{m.mode}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          {formatNumber(m.count)}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {data.total > 0
                            ? `${((m.count / data.total) * 100).toFixed(1)}%`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tool usage</CardTitle>
              <CardDescription>
                Anthropic tool-call activity over the window —{" "}
                {formatNumber(data.tools.turnsWithTools)} turns invoked at least
                one tool ({formatNumber(data.tools.totalInvocations)}{" "}
                invocations total).
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.tools.topTools.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No tool calls in this window.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground text-left text-xs">
                      <th className="pb-2 font-medium">Tool</th>
                      <th className="pb-2 text-right font-medium">Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tools.topTools.map((t) => (
                      <tr key={t.tool} className="border-border border-t">
                        <td className="py-1.5 font-mono text-xs">{t.tool}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          {formatNumber(t.count)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Top empty-retrieval queries
              </CardTitle>
              <CardDescription>
                Questions that returned no knowledge article — candidates for a
                new article or a tuned threshold.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.emptyRetrievalQueries.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No empty-retrieval turns in this window.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground text-left text-xs">
                      <th className="pb-2 font-medium">Message</th>
                      <th className="pb-2 text-right font-medium">Count</th>
                      <th className="pb-2 text-right font-medium">
                        Top distance
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.emptyRetrievalQueries.map((q, idx) => (
                      <tr key={idx} className="border-border border-t">
                        <td className="max-w-md py-1.5 pr-3 break-words">
                          {q.message}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {formatNumber(q.count)}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {q.topDistance === null
                            ? "—"
                            : q.topDistance.toFixed(3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Improvement queue</CardTitle>
              <CardDescription>
                Un-reviewed thumbs-down feedback from users. Draft an article
                from any row to pre-fill a knowledge entry with Haiku, then
                paste it into <code>/admin/aria-knowledge</code>. Dismiss rows
                that don&apos;t warrant new content.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {queueLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="text-muted-foreground size-4 animate-spin" />
                </div>
              ) : queue.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Queue is empty — no open thumbs-down feedback.
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {queue.map((q) => (
                    <li
                      key={q.id}
                      className={`
                        border-border/60 bg-muted/30 rounded-md border p-3
                      `}
                    >
                      <div
                        className={`
                          text-muted-foreground flex items-center
                          justify-between text-[11px]
                        `}
                      >
                        <span>
                          {q.user.name} ·{" "}
                          {new Date(q.createdAt).toLocaleString()}
                        </span>
                        {q.message.conversation.title ? (
                          <span className="truncate">
                            {q.message.conversation.title}
                          </span>
                        ) : null}
                      </div>
                      <p
                        className={`
                          text-foreground mt-1.5 line-clamp-3 text-[13px]
                          leading-snug
                        `}
                      >
                        {q.message.content}
                      </p>
                      {q.reason ? (
                        <p
                          className={`
                            border-destructive/30 bg-destructive/5
                            text-destructive mt-2 rounded border-l-2 px-2 py-1
                            text-[12px]
                          `}
                        >
                          <strong>Reason:</strong> {q.reason}
                        </p>
                      ) : null}
                      <div className="mt-2 flex justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDismiss(q.id)}
                          className="h-7 px-2.5 text-xs"
                        >
                          Dismiss
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDraft(q.id)}
                          disabled={draftingId === q.id}
                          className="h-7 px-2.5 text-xs"
                        >
                          {draftingId === q.id ? (
                            <Loader2 className="mr-1 size-3 animate-spin" />
                          ) : null}
                          Draft article
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent errors</CardTitle>
              <CardDescription>
                Last 20 turns where the LLM call failed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.recentErrors.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No errors in this window.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground text-left text-xs">
                      <th className="pb-2 font-medium">When</th>
                      <th className="pb-2 font-medium">Message</th>
                      <th className="pb-2 font-medium">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentErrors.map((e) => (
                      <tr key={e.id} className="border-border border-t">
                        <td className="py-1.5 pr-3 text-xs whitespace-nowrap">
                          {new Date(e.createdAt).toLocaleString()}
                        </td>
                        <td className="max-w-sm py-1.5 pr-3 break-words">
                          {e.message}
                        </td>
                        <td
                          className={`
                            text-muted-foreground py-1.5 pr-3 text-xs
                            break-words
                          `}
                        >
                          {e.errorMessage ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
