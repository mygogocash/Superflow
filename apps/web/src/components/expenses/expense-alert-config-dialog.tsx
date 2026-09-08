"use client";

import { Bell, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { ApiError } from "@/lib/api-client";
import {
  type ExpenseReminderSettings,
  getExpenseReminderSettings,
  setExpenseReminderSettings,
} from "@/services/expense.service";

// Curated IANA timezones covering all company office locations.
const TIMEZONES: { label: string; value: string }[] = [
  { label: "Bangkok (UTC+7)", value: "Asia/Bangkok" },
  { label: "Kolkata / Mumbai (UTC+5:30)", value: "Asia/Kolkata" },
  { label: "Jakarta (UTC+7)", value: "Asia/Jakarta" },
  { label: "Ho Chi Minh (UTC+7)", value: "Asia/Ho_Chi_Minh" },
  { label: "Singapore (UTC+8)", value: "Asia/Singapore" },
  { label: "Kuala Lumpur (UTC+8)", value: "Asia/Kuala_Lumpur" },
  { label: "Dubai (UTC+4)", value: "Asia/Dubai" },
  { label: "London (UTC+0/+1)", value: "Europe/London" },
  { label: "Paris / Berlin (UTC+1/+2)", value: "Europe/Paris" },
  { label: "New York (UTC-5/-4)", value: "America/New_York" },
  { label: "Los Angeles (UTC-8/-7)", value: "America/Los_Angeles" },
  { label: "UTC", value: "UTC" },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEFAULT_SETTINGS: ExpenseReminderSettings = {
  reminderDay: 22,
  reminderTime: "09:00",
  reminderTimezone: "Asia/Bangkok",
  enableThailand: true,
  enableInternational: true,
};

export function ExpenseAlertConfigDialog({ open, onOpenChange }: Props) {
  const [settings, setSettings] =
    useState<ExpenseReminderSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await getExpenseReminderSettings();
      setSettings(res.data.settings);
    } catch {
      // non-critical — keep defaults
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function save() {
    try {
      setSaving(true);
      const res = await setExpenseReminderSettings(settings);
      setSettings(res.data.settings);
      toast.success("Alert settings saved");
      onOpenChange(false);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Failed to save settings";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bell className="size-4" />
            Expense Alert Configuration
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-5 py-1">
            {/* Schedule row */}
            <div className="grid grid-cols-3 gap-3">
              {/* Day */}
              <div className="space-y-1.5">
                <Label htmlFor="reminder-day" className="text-sm font-medium">
                  Day of month
                </Label>
                <Input
                  id="reminder-day"
                  type="number"
                  min={1}
                  max={31}
                  value={settings.reminderDay}
                  onChange={(e) => {
                    const v = Math.min(31, Math.max(1, Number(e.target.value)));
                    setSettings((s) => ({ ...s, reminderDay: v }));
                  }}
                  disabled={saving}
                  className="w-full"
                />
                <p className="text-muted-foreground text-xs">1 – 31</p>
              </div>

              {/* Time */}
              <div className="space-y-1.5">
                <Label htmlFor="reminder-time" className="text-sm font-medium">
                  Time
                </Label>
                <Input
                  id="reminder-time"
                  type="time"
                  value={settings.reminderTime}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      reminderTime: e.target.value,
                    }))
                  }
                  disabled={saving}
                  className="w-full"
                />
                <p className="text-muted-foreground text-xs">24-hour (HH:MM)</p>
              </div>

              {/* Timezone */}
              <div className="space-y-1.5">
                <Label htmlFor="reminder-tz" className="text-sm font-medium">
                  Timezone
                </Label>
                <Select
                  value={settings.reminderTimezone}
                  onValueChange={(v) =>
                    setSettings((s) => ({ ...s, reminderTimezone: v }))
                  }
                  disabled={saving}
                >
                  <SelectTrigger id="reminder-tz" className="w-full">
                    <SelectValue placeholder="Select timezone" />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map((tz) => (
                      <SelectItem key={tz.value} value={tz.value}>
                        {tz.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">IANA timezone</p>
              </div>
            </div>

            {/* Thailand variant */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-4">
                <Label
                  htmlFor="enable-thailand"
                  className="cursor-pointer text-sm font-medium"
                >
                  Manut Thailand (TH entity)
                </Label>
                <Switch
                  id="enable-thailand"
                  checked={settings.enableThailand}
                  onCheckedChange={(checked) =>
                    setSettings((s) => ({ ...s, enableThailand: checked }))
                  }
                  disabled={saving}
                />
              </div>
              <p
                className={`
                  text-muted-foreground rounded-sm border-l-2 pl-3 text-xs
                  leading-relaxed
                `}
              >
                Subject: &ldquo;Reminder: submit your monthly allowance&rdquo;
                <br />
                Includes: Meal allowance, Transportation allowance, Phone
                allowance, Other reimbursements
              </p>
            </div>

            {/* International variant */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-4">
                <Label
                  htmlFor="enable-international"
                  className="cursor-pointer text-sm font-medium"
                >
                  India &amp; Other Countries
                </Label>
                <Switch
                  id="enable-international"
                  checked={settings.enableInternational}
                  onCheckedChange={(checked) =>
                    setSettings((s) => ({
                      ...s,
                      enableInternational: checked,
                    }))
                  }
                  disabled={saving}
                />
              </div>
              <p
                className={`
                  text-muted-foreground rounded-sm border-l-2 pl-3 text-xs
                  leading-relaxed
                `}
              >
                Subject: &ldquo;Reminder: submit your monthly
                reimbursement&rdquo;
                <br />
                Includes: Monthly reimbursement claims, Internet bills, Other
                eligible expenses
              </p>
            </div>

            {!settings.enableThailand && !settings.enableInternational && (
              <p className="text-destructive text-xs">
                All variants are disabled — no reminder emails will be sent on
                the {settings.reminderDay}th.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={loading || saving}>
            {saving ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
