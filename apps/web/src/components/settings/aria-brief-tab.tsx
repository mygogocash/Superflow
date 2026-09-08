"use client";

/**
 * ARIA daily-brief preferences tab.
 *
 * Two sections:
 *
 * 1. "Subscription" — toggle + hour + timezone + channels + weekdays-only +
 *    section allowlist. Every change writes through to
 *    `PUT /aria/brief/subscription` immediately and toasts on success;
 *    no separate Save button to keep the surface low-friction.
 *
 * 2. "Past briefs" — last 14 deliveries, newest first, with a "Preview now"
 *    button at the top that fires `POST /aria/brief/run` so the user can
 *    QA their section choices without waiting for tomorrow's cron.
 */
import { Bell, Calendar, Clock, Inbox, Mail, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api-client";
import {
  type BriefChannel,
  type BriefDelivery,
  type BriefSectionId,
  type BriefSubscription,
  getAriaBriefSubscription,
  listAriaBriefDeliveries,
  runAriaBriefNow,
  updateAriaBriefSubscription,
} from "@/services/aria.service";

const HOURS = Array.from({ length: 24 }, (_, i) => i);
// Curated short list; users with exotic timezones can keep whatever
// the API returns. We don't try to enumerate every IANA id because
// the dropdown becomes unscrollable.
const TIMEZONE_OPTIONS = [
  "Asia/Bangkok",
  "Asia/Kolkata",
  "Asia/Ho_Chi_Minh",
  "Asia/Jakarta",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Dubai",
  "Europe/London",
  "America/Los_Angeles",
  "America/New_York",
  "UTC",
];

const SECTION_LABEL: Record<BriefSectionId, string> = {
  calendar: "Today's calendar",
  approvals: "Pending your approval",
  "leave-balance": "Your leave balance (Mondays)",
  "expiring-visas": "Expiring visas (HR)",
  pipeline: "Pipeline closing this week (BD)",
  "helpdesk-mine": "IT tickets assigned to you",
};

export function AriaBriefTab() {
  const [subscription, setSubscription] = useState<BriefSubscription | null>(
    null,
  );
  const [availableSections, setAvailableSections] = useState<BriefSectionId[]>(
    [],
  );
  const [deliveries, setDeliveries] = useState<BriefDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [{ subscription, availableSections }, deliveries] =
        await Promise.all([
          getAriaBriefSubscription(),
          listAriaBriefDeliveries(14),
        ]);
      setSubscription(subscription);
      setAvailableSections(availableSections);
      setDeliveries(deliveries);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Failed to load brief settings";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (changes: Partial<BriefSubscription>) => {
    if (!subscription) return;
    // Optimistic update so toggles feel instant. Roll back on error.
    const prev = subscription;
    setSubscription({ ...subscription, ...changes });
    try {
      setSaving(true);
      const next = await updateAriaBriefSubscription({
        enabled: changes.enabled,
        hourLocal: changes.hourLocal,
        timezone: changes.timezone,
        channels: changes.channels,
        sections: changes.sections,
        weekdaysOnly: changes.weekdaysOnly,
      });
      setSubscription(next);
    } catch (err) {
      setSubscription(prev);
      const message =
        err instanceof ApiError ? err.message : "Failed to save preferences";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const toggleChannel = (channel: BriefChannel) => {
    if (!subscription) return;
    const has = subscription.channels.includes(channel);
    const next = has
      ? subscription.channels.filter((c) => c !== channel)
      : [...subscription.channels, channel];
    if (next.length === 0) {
      toast.error("Pick at least one channel — disable the brief instead.");
      return;
    }
    void patch({ channels: next });
  };

  const toggleSection = (section: BriefSectionId) => {
    if (!subscription) return;
    // sections=[] in the API means "all". Convert empty-state UX
    // into an explicit allowlist the moment the user opts one out.
    const current =
      subscription.sections.length === 0
        ? availableSections.slice()
        : subscription.sections.slice();
    const has = current.includes(section);
    const next = has
      ? current.filter((s) => s !== section)
      : [...current, section];
    // Empty array in the API contract means "all sections" — so a
    // user who unticks every section would silently get the full
    // brief, the opposite of intent. Block the patch and tell them
    // to disable the brief instead.
    if (next.length === 0) {
      toast.error(
        "Pick at least one section, or disable the daily brief above.",
      );
      return;
    }
    void patch({ sections: next });
  };

  const previewNow = async () => {
    try {
      setPreviewing(true);
      const result = await runAriaBriefNow();
      if ("empty" in result && result.empty) {
        toast.info("Nothing on your plate right now — empty brief.");
      } else {
        toast.success("Brief generated. Check your Manut AI conversations.");
      }
      await load();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Failed to generate brief";
      toast.error(message);
    } finally {
      setPreviewing(false);
    }
  };

  if (loading || !subscription) {
    return (
      <Card>
        <CardContent className="text-muted-foreground py-10 text-center">
          Loading brief settings…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="size-4" /> Daily brief
          </CardTitle>
          <CardDescription>
            Manut AI can send a short, personalised summary every morning —
            today&apos;s calendar, pending approvals, anything that needs your
            attention. The summary itself doesn&apos;t cost any AI credit; only
            follow-up questions do.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">Receive daily brief</Label>
              <p className="text-muted-foreground text-xs">
                Toggle off to stop deliveries without losing your other
                preferences.
              </p>
            </div>
            <Switch
              checked={subscription.enabled}
              disabled={saving}
              onCheckedChange={(v) => void patch({ enabled: Boolean(v) })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="flex items-center gap-2 text-sm">
                <Clock className="size-3.5" /> Time of day
              </Label>
              <Select
                value={String(subscription.hourLocal)}
                onValueChange={(v) =>
                  void patch({ hourLocal: Number.parseInt(v, 10) })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {`${String(h).padStart(2, "0")}:00`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="flex items-center gap-2 text-sm">
                <Calendar className="size-3.5" /> Timezone
              </Label>
              <Select
                value={subscription.timezone}
                onValueChange={(v) => void patch({ timezone: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONE_OPTIONS.includes(subscription.timezone) ? null : (
                    <SelectItem value={subscription.timezone}>
                      {subscription.timezone}
                    </SelectItem>
                  )}
                  {TIMEZONE_OPTIONS.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">Weekdays only</Label>
              <p className="text-muted-foreground text-xs">
                Skip Saturday and Sunday.
              </p>
            </div>
            <Switch
              checked={subscription.weekdaysOnly}
              disabled={saving}
              onCheckedChange={(v) => void patch({ weekdaysOnly: Boolean(v) })}
            />
          </div>

          <div>
            <Label className="text-sm font-medium">Channels</Label>
            <div className="flex flex-wrap gap-3">
              <label
                className={`
                  flex items-center gap-2 rounded-md border px-3 py-2 text-sm
                `}
              >
                <Checkbox
                  checked={subscription.channels.includes("in_app")}
                  onCheckedChange={() => toggleChannel("in_app")}
                />
                <Inbox className="size-3.5" />
                In-app inbox
              </label>
              <label
                className={`
                  flex items-center gap-2 rounded-md border px-3 py-2 text-sm
                `}
              >
                <Checkbox
                  checked={subscription.channels.includes("email")}
                  onCheckedChange={() => toggleChannel("email")}
                />
                <Mail className="size-3.5" />
                Email
              </label>
            </div>
          </div>

          <div>
            <Label className="text-sm font-medium">Sections</Label>
            <p className="text-muted-foreground text-xs">
              Untick a section to drop it from your brief. Sections you
              don&apos;t have permission for are silently skipped.
            </p>
            <div
              className={`
                grid grid-cols-1 gap-2
                md:grid-cols-2
              `}
            >
              {availableSections.map((s) => {
                const enabled =
                  subscription.sections.length === 0 ||
                  subscription.sections.includes(s);
                return (
                  <label
                    key={s}
                    className={`
                      flex items-center gap-2 rounded-md border px-3 py-2
                      text-sm
                    `}
                  >
                    <Checkbox
                      checked={enabled}
                      onCheckedChange={() => toggleSection(s)}
                    />
                    {SECTION_LABEL[s] ?? s}
                  </label>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Past briefs</CardTitle>
              <CardDescription>
                Last 14 deliveries. Click a date to open the conversation.
              </CardDescription>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={previewing}
              onClick={previewNow}
            >
              <RefreshCw
                className={`
                  mr-2 size-3.5
                  ${previewing ? "animate-spin" : ""}
                `}
              />
              Preview now
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {deliveries.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No briefs yet. The first delivery lands on your next configured
              hour.
            </p>
          ) : (
            <ul className="divide-y">
              {deliveries.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between py-2 text-sm"
                >
                  <div>
                    <p className="font-medium">{d.deliveredOn}</p>
                    <p className="text-muted-foreground text-xs">
                      {d.payloadJson.totalAttention} item
                      {d.payloadJson.totalAttention === 1 ? "" : "s"} ·{" "}
                      {d.payloadJson.sections
                        .map((s) => s.title)
                        .slice(0, 3)
                        .join(", ")}
                      {d.payloadJson.sections.length > 3 ? "…" : ""}
                    </p>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {channelStatusLabel(d.channelStatus)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function channelStatusLabel(status: Record<string, string>): string {
  // Compress `{in_app: "ok", email: "error:send_failed"}` to "in-app ok · email error"
  return Object.entries(status)
    .map(([k, v]) => `${k.replace("_", "-")} ${v.split(":")[0]}`)
    .join(" · ");
}
