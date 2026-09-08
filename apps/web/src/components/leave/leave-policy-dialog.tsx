"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { UserMultiSelect } from "@/components/shared/user-multi-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
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
import { type Entity, listEntities } from "@/services/entity.service";
import {
  createLeaveType,
  getLeavePolicyApprovers,
  type LeaveApproverType,
  type LeaveType,
  setLeavePolicyApprovers,
  updateLeaveType,
} from "@/services/leave.service";
import { listUsers, type UserListItem } from "@/services/user.service";

const ENTITY_GLOBAL = "__global__" as const;

const CATEGORIES = [
  { value: "sick", label: "Sick" },
  { value: "casual", label: "Casual" },
  { value: "earned", label: "Earned" },
  { value: "paid", label: "Paid" },
  { value: "unpaid", label: "Unpaid" },
  { value: "other", label: "Other" },
] as const;

const policySchema = z.object({
  entityId: z.string().min(1),
  name: z.string().min(1, "Name is required").max(100),
  code: z
    .string()
    .min(1, "Code is required")
    .max(20)
    .regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, _ or - only"),
  description: z.string().max(2000).optional(),
  category: z.enum(["sick", "casual", "earned", "paid", "unpaid", "other"]),
  daysPerYear: z.coerce.number().int().min(0).max(365),
  requiresApproval: z.boolean(),
  isPaid: z.boolean(),
  isActive: z.boolean(),
});

type PolicyFormValues = z.infer<typeof policySchema>;

interface ApproverDraft {
  // Stable client-only id so React keys + the per-row "Conditions" open-state
  // bind to the row, not its index (rows can be reordered / removed).
  uid: string;
  approverType: LeaveApproverType;
  approverUserId: string | null;
  skipWhenSubmitterIds: string[];
  onlyWhenSubmitterIds: string[];
  minDays: number | null;
  maxDays: number | null;
}

function newApproverDraft(): ApproverDraft {
  return {
    uid: crypto.randomUUID(),
    approverType: "manager",
    approverUserId: null,
    skipWhenSubmitterIds: [],
    onlyWhenSubmitterIds: [],
    minDays: null,
    maxDays: null,
  };
}

interface LeavePolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policy: LeaveType | null;
  onSaved: () => void;
}

export function LeavePolicyDialog({
  open,
  onOpenChange,
  policy,
  onSaved,
}: LeavePolicyDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [approvers, setApprovers] = useState<ApproverDraft[]>([]);
  const [expandedConditions, setExpandedConditions] = useState<Set<string>>(
    new Set(),
  );
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [approversLoading, setApproversLoading] = useState(false);
  const editing = Boolean(policy);

  const form = useForm<PolicyFormValues>({
    resolver: zodResolver(policySchema),
    defaultValues: {
      entityId: ENTITY_GLOBAL,
      name: "",
      code: "",
      description: "",
      category: "other",
      daysPerYear: 0,
      requiresApproval: true,
      isPaid: true,
      isActive: true,
    },
  });

  const requiresApproval = form.watch("requiresApproval");

  // Load users + entities + approvers when dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        setUsersLoading(true);
        const [usersRes, entitiesRes] = await Promise.all([
          listUsers({ limit: 200, isActive: true }),
          listEntities(),
        ]);
        if (!cancelled) {
          setUsers(usersRes.data);
          setEntities(entitiesRes.data);
        }
      } catch {
        if (!cancelled) toast.error("Failed to load employees");
      } finally {
        if (!cancelled) setUsersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setExpandedConditions(new Set());
    if (policy) {
      void (async () => {
        try {
          setApproversLoading(true);
          const res = await getLeavePolicyApprovers(policy.id);
          setApprovers(
            res.data.map((a) => ({
              uid: crypto.randomUUID(),
              approverType: a.approverType,
              approverUserId: a.approverUserId,
              skipWhenSubmitterIds: a.skipWhenSubmitterIds ?? [],
              onlyWhenSubmitterIds: a.onlyWhenSubmitterIds ?? [],
              minDays: a.minDays ?? null,
              maxDays: a.maxDays ?? null,
            })),
          );
        } catch {
          setApprovers([]);
        } finally {
          setApproversLoading(false);
        }
      })();
    } else {
      setApprovers([]);
    }
  }, [open, policy]);

  useEffect(() => {
    if (!open) return;
    form.reset(
      policy
        ? {
            entityId: policy.entityId ?? ENTITY_GLOBAL,
            name: policy.name,
            code: policy.code,
            description: policy.description ?? "",
            category: policy.category,
            daysPerYear: policy.daysPerYear,
            requiresApproval: policy.requiresApproval,
            isPaid: policy.isPaid,
            isActive: policy.isActive,
          }
        : {
            entityId: ENTITY_GLOBAL,
            name: "",
            code: "",
            description: "",
            category: "other",
            daysPerYear: 0,
            requiresApproval: true,
            isPaid: true,
            isActive: true,
          },
    );
  }, [open, policy, form]);

  function addApprover() {
    setApprovers((prev) => [...prev, newApproverDraft()]);
  }

  function removeApprover(idx: number) {
    setApprovers((prev) => prev.filter((_, i) => i !== idx));
  }

  function toggleConditions(uid: string) {
    setExpandedConditions((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function moveApprover(idx: number, dir: -1 | 1) {
    const next = idx + dir;
    if (next < 0 || next >= approvers.length) return;
    setApprovers((prev) => {
      const copy = [...prev];
      const [item] = copy.splice(idx, 1);
      copy.splice(next, 0, item!);
      return copy;
    });
  }

  function updateApprover(idx: number, patch: Partial<ApproverDraft>) {
    setApprovers((prev) =>
      prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)),
    );
  }

  function validateApprovers(): string | null {
    for (const a of approvers) {
      if (a.approverType === "user" && !a.approverUserId) {
        return "Pick a user for every 'Specific user' step";
      }
      if (a.minDays != null && a.minDays < 0) {
        return "Min days cannot be negative";
      }
      if (a.maxDays != null && a.maxDays < 0) {
        return "Max days cannot be negative";
      }
      if (a.minDays != null && a.maxDays != null && a.maxDays < a.minDays) {
        return "Max days must be greater than or equal to min days";
      }
    }
    return null;
  }

  async function onSubmit(values: PolicyFormValues) {
    const approverError = validateApprovers();
    if (approverError) {
      toast.error(approverError);
      return;
    }

    try {
      setSubmitting(true);
      const payload = {
        ...values,
        entityId: values.entityId === ENTITY_GLOBAL ? null : values.entityId,
        code: values.code.toUpperCase(),
        description: values.description?.trim() || undefined,
      };

      let policyId: string;
      if (policy) {
        await updateLeaveType(policy.id, payload);
        policyId = policy.id;
      } else {
        const created = await createLeaveType(payload);
        policyId = created.data.id;
      }

      // Always sync approvers (empty list clears them).
      await setLeavePolicyApprovers(policyId, {
        approvers: approvers.map((a) => ({
          approverType: a.approverType,
          approverUserId: a.approverType === "user" ? a.approverUserId : null,
          skipWhenSubmitterIds: a.skipWhenSubmitterIds,
          onlyWhenSubmitterIds: a.onlyWhenSubmitterIds,
          minDays: a.minDays,
          maxDays: a.maxDays,
        })),
      });

      toast.success(
        policy
          ? `Policy "${payload.name}" updated`
          : `Policy "${payload.name}" created`,
      );
      onSaved();
      onOpenChange(false);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to save policy";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent
        className={`
          max-h-[92vh] overflow-y-auto
          sm:max-w-2xl
        `}
      >
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit leave policy" : "Create leave policy"}
          </DialogTitle>
          <DialogDescription>
            Define the leave type, the days granted per year, and who approves
            requests under this policy.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            id="leave-policy-form"
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="entityId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Entity</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={ENTITY_GLOBAL}>
                        Global (all entities)
                      </SelectItem>
                      {entities.map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {e.name} ({e.code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Pick a specific entity (e.g. Manut Thailand) to scope this
                    policy. Global policies apply to every employee.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div
              className={`
                grid grid-cols-1 gap-4
                sm:grid-cols-2
              `}
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Annual Leave" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Code</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="ANNUAL"
                        {...field}
                        onChange={(e) =>
                          field.onChange(e.target.value.toUpperCase())
                        }
                      />
                    </FormControl>
                    <FormDescription>
                      Short uppercase identifier used in balances and reports.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      placeholder="Who this policy applies to and how it accrues."
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div
              className={`
                grid grid-cols-1 gap-4
                sm:grid-cols-2
              `}
            >
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CATEGORIES.map((c) => (
                          <SelectItem key={c.value} value={c.value}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="daysPerYear"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Days per year</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={365}
                        {...field}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === "" ? 0 : Number(e.target.value),
                          )
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="space-y-3 rounded-md border p-4">
              <FormField
                control={form.control}
                name="requiresApproval"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between">
                    <div>
                      <FormLabel>Requires approval</FormLabel>
                      <FormDescription>
                        Manager (or HR) must approve every request.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="isPaid"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between">
                    <div>
                      <FormLabel>Paid leave</FormLabel>
                      <FormDescription>
                        Salary continues during the leave period.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between">
                    <div>
                      <FormLabel>Active</FormLabel>
                      <FormDescription>
                        Inactive policies stay visible to admins but cannot be
                        used for new requests.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <div className="space-y-3 rounded-md border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <Users className="h-4 w-4" />
                    Approval chain
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    Steps decide requests in order and{" "}
                    <span className="font-medium">override</span> the org-wide
                    default chain for this leave type. Leave empty to use the{" "}
                    <Link
                      href="/leave/approval"
                      className="underline underline-offset-2"
                    >
                      default chain
                    </Link>
                    ; if neither is set, the submitter&apos;s direct manager
                    approves.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={addApprover}
                  disabled={!requiresApproval}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Add step
                </Button>
              </div>

              {!requiresApproval && (
                <p className="text-muted-foreground text-xs italic">
                  Approval is disabled — requests under this policy auto-apply.
                </p>
              )}

              {requiresApproval && approversLoading && (
                <p
                  className={`
                    text-muted-foreground flex items-center gap-2 text-xs
                  `}
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading approvers…
                </p>
              )}

              {requiresApproval &&
                !approversLoading &&
                approvers.length === 0 && (
                  <p className="text-muted-foreground text-xs italic">
                    No approvers configured. Manager approval applies by
                    default.
                  </p>
                )}

              {requiresApproval &&
                !approversLoading &&
                approvers.map((a, idx) => {
                  const condOpen = expandedConditions.has(a.uid);
                  const condParts: string[] = [];
                  if (a.onlyWhenSubmitterIds.length > 0) {
                    condParts.push(`only ${a.onlyWhenSubmitterIds.length}`);
                  }
                  if (a.skipWhenSubmitterIds.length > 0) {
                    condParts.push(`skip ${a.skipWhenSubmitterIds.length}`);
                  }
                  if (a.minDays != null || a.maxDays != null) {
                    condParts.push(
                      `${a.minDays ?? 0}–${a.maxDays ?? "∞"} days`,
                    );
                  }
                  return (
                    <div
                      key={a.uid}
                      className={`
                        bg-surface-secondary/40 flex flex-col gap-2 rounded-md
                        border p-2
                      `}
                    >
                      <div
                        className={`
                          flex flex-col gap-2
                          sm:grid sm:grid-cols-[32px_180px_minmax(0,1fr)_auto]
                          sm:items-center
                        `}
                      >
                        <div
                          className={`
                            flex items-center justify-between gap-2
                            sm:contents
                          `}
                        >
                          <span
                            className={`
                              text-muted-foreground font-mono text-xs
                              sm:text-center
                            `}
                          >
                            {idx + 1}
                          </span>
                          <Select
                            value={a.approverType}
                            onValueChange={(v) =>
                              updateApprover(idx, {
                                approverType: v as LeaveApproverType,
                                approverUserId:
                                  v === "manager" ? null : a.approverUserId,
                              })
                            }
                          >
                            <SelectTrigger
                              className={`
                                h-9 w-full
                                sm:w-auto
                              `}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="manager">
                                Submitter&apos;s manager
                              </SelectItem>
                              <SelectItem value="user">
                                Specific user
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {a.approverType === "user" ? (
                          <Select
                            value={a.approverUserId ?? ""}
                            onValueChange={(v) =>
                              updateApprover(idx, { approverUserId: v || null })
                            }
                            disabled={usersLoading}
                          >
                            <SelectTrigger className="h-9 w-full">
                              <SelectValue
                                placeholder={
                                  usersLoading ? "Loading…" : "Select user"
                                }
                              />
                            </SelectTrigger>
                            <SelectContent>
                              {users.map((u) => (
                                <SelectItem key={u.id} value={u.id}>
                                  {u.name}
                                  {u.email ? (
                                    <span
                                      className={`
                                        text-muted-foreground ml-2 text-xs
                                      `}
                                    >
                                      {u.email}
                                    </span>
                                  ) : null}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span
                            className={`
                              text-muted-foreground min-w-0 truncate text-xs
                            `}
                          >
                            Resolves to the submitter&apos;s direct manager.
                          </span>
                        )}
                        <div
                          className={`
                            inline-flex justify-end gap-0.5
                            sm:justify-start
                          `}
                        >
                          <Button
                            type="button"
                            size="icon-sm"
                            variant={condOpen ? "secondary" : "ghost"}
                            onClick={() => toggleConditions(a.uid)}
                            aria-label="Conditions"
                            aria-expanded={condOpen}
                          >
                            {condOpen ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            disabled={idx === 0}
                            onClick={() => moveApprover(idx, -1)}
                            aria-label="Move up"
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            disabled={idx === approvers.length - 1}
                            onClick={() => moveApprover(idx, 1)}
                            aria-label="Move down"
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => removeApprover(idx)}
                            aria-label="Remove"
                          >
                            <Trash2 className="text-destructive h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>

                      {!condOpen && condParts.length > 0 && (
                        <button
                          type="button"
                          onClick={() => toggleConditions(a.uid)}
                          className={`
                            text-muted-foreground self-start text-[11px]
                            hover:underline
                          `}
                        >
                          Conditions: {condParts.join(" · ")}
                        </button>
                      )}

                      {condOpen && (
                        <div className="space-y-3 border-t pt-3">
                          <div
                            className={`
                              grid gap-3
                              sm:grid-cols-2
                            `}
                          >
                            <div>
                              <p className="mb-1 text-xs font-medium">
                                Skip when submitter is
                              </p>
                              <p
                                className={`
                                  text-muted-foreground mb-1.5 text-[11px]
                                `}
                              >
                                Submitters who should not trigger this step
                                (e.g. exclude an approver from their own
                                request).
                              </p>
                              <UserMultiSelect
                                users={users}
                                value={a.skipWhenSubmitterIds}
                                onChange={(next) =>
                                  updateApprover(idx, {
                                    skipWhenSubmitterIds: next,
                                  })
                                }
                                placeholder="Pick submitters to skip…"
                                disabled={usersLoading}
                              />
                            </div>
                            <div>
                              <p className="mb-1 text-xs font-medium">
                                Only when submitter is
                              </p>
                              <p
                                className={`
                                  text-muted-foreground mb-1.5 text-[11px]
                                `}
                              >
                                When set, this step only fires for these
                                submitters. Empty = applies to everyone.
                              </p>
                              <UserMultiSelect
                                users={users}
                                value={a.onlyWhenSubmitterIds}
                                onChange={(next) =>
                                  updateApprover(idx, {
                                    onlyWhenSubmitterIds: next,
                                  })
                                }
                                placeholder="Empty = applies to everyone"
                                disabled={usersLoading}
                              />
                            </div>
                          </div>
                          <div
                            className={`
                              grid gap-3
                              sm:grid-cols-2
                            `}
                          >
                            <div>
                              <p className="mb-1 text-xs font-medium">
                                Min days
                              </p>
                              <Input
                                type="number"
                                min={0}
                                step={1}
                                value={a.minDays ?? ""}
                                placeholder="No minimum"
                                onChange={(e) =>
                                  updateApprover(idx, {
                                    minDays:
                                      e.target.value === ""
                                        ? null
                                        : Math.max(
                                            0,
                                            Math.floor(Number(e.target.value)),
                                          ),
                                  })
                                }
                              />
                            </div>
                            <div>
                              <p className="mb-1 text-xs font-medium">
                                Max days
                              </p>
                              <Input
                                type="number"
                                min={0}
                                step={1}
                                value={a.maxDays ?? ""}
                                placeholder="No maximum"
                                onChange={(e) =>
                                  updateApprover(idx, {
                                    maxDays:
                                      e.target.value === ""
                                        ? null
                                        : Math.max(
                                            0,
                                            Math.floor(Number(e.target.value)),
                                          ),
                                  })
                                }
                              />
                            </div>
                          </div>
                          <p className="text-muted-foreground text-[11px]">
                            This step applies only when the request&apos;s total
                            days fall within the band (inclusive; leave a bound
                            empty for open-ended).
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </form>
        </Form>

        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" form="leave-policy-form" disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? "Save changes" : "Create policy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
