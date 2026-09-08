"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Paperclip, Trash2, UploadCloud } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { FormDatePicker } from "@/components/shared/form-date-picker";
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
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api-client";
import { type Entity, listEntities } from "@/services/entity.service";
import {
  createNinetyDayNotification,
  NINETY_DAY_STATUS_LABELS,
  NINETY_DAY_STATUSES,
  type NinetyDayNotification,
  type NinetyDayReceipt,
  updateNinetyDayNotification,
} from "@/services/ninety-day.service";
import { uploadFile } from "@/services/upload.service";
import { listUsers, type UserListItem } from "@/services/user.service";

const NO_ENTITY = "__none__";

const formSchema = z
  .object({
    employeeId: z.string().uuid("Pick a sponsor employee from the list"),
    entityId: z.string().optional().or(z.literal("")),
    holderType: z.enum(["employee", "dependent"]),
    holderName: z.string().max(200).optional().or(z.literal("")),
    holderRelationship: z.string().max(200).optional().or(z.literal("")),
    lastArrivalDate: z
      .string()
      .min(1, "Last arrival date is required")
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
    status: z.enum(NINETY_DAY_STATUSES),
    notes: z.string().max(2000).optional().or(z.literal("")),
    receipt: z
      .object({
        name: z.string().min(1),
        url: z.string().url(),
        mimeType: z.string().optional(),
      })
      .nullable()
      .optional(),
  })
  .superRefine((val, ctx) => {
    if (val.holderType === "dependent" && !val.holderName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["holderName"],
        message: "Holder name is required for non-employee applicants",
      });
    }
  });

type FormValues = z.infer<typeof formSchema>;

function ReceiptUploadField({
  receipt,
  onChange,
  disabled,
}: {
  receipt: NinetyDayReceipt | null | undefined;
  onChange: (next: NinetyDayReceipt | null) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleFile(file: File) {
    try {
      setUploading(true);
      const result = await uploadFile(file, {
        bucket: "documents",
        purpose: "ninety-day-receipt",
      });
      onChange({
        name: result.originalName,
        url: result.url,
        mimeType: result.mimeType || undefined,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <FormLabel>Receipt / submission proof</FormLabel>
      <div
        className={`
          border-border/60 flex items-center justify-between gap-2 rounded-md
          border p-2
        `}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <Paperclip className="text-muted-foreground size-3.5 shrink-0" />
          <div className="min-w-0">
            {receipt ? (
              <span className="text-foreground truncate font-medium">
                {receipt.name}
              </span>
            ) : (
              <span className="text-muted-foreground text-xs">
                PDF or image, max 50 MB
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept="application/pdf,image/*"
            disabled={disabled || uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <UploadCloud className="size-3.5" />
            )}
            {receipt ? "Replace" : "Upload"}
          </Button>
          {receipt ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || uploading}
              onClick={() => onChange(null)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Store the Immigration receipt or TM.47 submission proof with this
        record.
      </p>
    </div>
  );
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record?: NinetyDayNotification | null;
  onSaved: (saved: NinetyDayNotification) => void;
}

export function NinetyDayFormDialog({
  open,
  onOpenChange,
  record,
  onSaved,
}: Props) {
  const isEditing = !!record;
  const [submitting, setSubmitting] = useState(false);
  const [employees, setEmployees] = useState<UserListItem[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(false);
  const [entities, setEntities] = useState<Entity[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        setEmployeesLoading(true);
        const res = await listUsers({ limit: 500, isActive: true });
        if (!cancelled) setEmployees(res.data);
      } catch {
        if (!cancelled) toast.error("Failed to load employees");
      } finally {
        if (!cancelled) setEmployeesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listEntities()
      .then((res) => {
        if (!cancelled) setEntities(res.data);
      })
      .catch(() => {
        // Optional — non-admin roles may lack admin:read.
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      employeeId: "",
      entityId: "",
      holderType: "employee",
      holderName: "",
      holderRelationship: "",
      lastArrivalDate: "",
      status: "pending",
      notes: "",
      receipt: null,
    },
  });

  useEffect(() => {
    if (!open) return;
    if (record) {
      form.reset({
        employeeId: record.employeeId,
        entityId: record.entityId ?? "",
        holderType: record.holderType,
        holderName: record.holderName ?? "",
        holderRelationship: record.holderRelationship ?? "",
        lastArrivalDate: record.lastArrivalDate,
        status: record.status,
        notes: record.notes ?? "",
        receipt: record.receipt
          ? {
              name: record.receipt.name,
              url: record.receipt.url,
              mimeType: record.receipt.mimeType ?? undefined,
            }
          : null,
      });
    } else {
      form.reset({
        employeeId: "",
        entityId: "",
        holderType: "employee",
        holderName: "",
        holderRelationship: "",
        lastArrivalDate: "",
        status: "pending",
        notes: "",
        receipt: null,
      });
    }
  }, [open, record, form]);

  async function onSubmit(values: FormValues) {
    try {
      setSubmitting(true);
      const entityId = values.entityId ? values.entityId : null;
      const isDependent = values.holderType === "dependent";
      const holderName = isDependent
        ? values.holderName?.trim() || undefined
        : undefined;
      const holderRelationship = isDependent
        ? values.holderRelationship?.trim() || undefined
        : undefined;

      if (isEditing && record) {
        const res = await updateNinetyDayNotification(record.id, {
          entityId,
          holderType: values.holderType,
          holderName: isDependent ? (holderName ?? null) : null,
          holderRelationship: isDependent ? (holderRelationship ?? null) : null,
          lastArrivalDate: values.lastArrivalDate,
          status: values.status,
          notes: values.notes || undefined,
          receipt: values.receipt
            ? {
                name: values.receipt.name,
                url: values.receipt.url,
                mimeType: values.receipt.mimeType ?? undefined,
              }
            : null,
        });
        toast.success("90-day notification updated");
        onSaved(res.data);
      } else {
        const res = await createNinetyDayNotification({
          employeeId: values.employeeId,
          entityId: entityId ?? undefined,
          holderType: values.holderType,
          holderName,
          holderRelationship,
          lastArrivalDate: values.lastArrivalDate,
          status: values.status,
          notes: values.notes || undefined,
          receipt: values.receipt
            ? {
                name: values.receipt.name,
                url: values.receipt.url,
                mimeType: values.receipt.mimeType ?? undefined,
              }
            : undefined,
        });
        toast.success("90-day notification created");
        onSaved(res.data);
      }
      onOpenChange(false);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Something went wrong";
      toast.error(msg);
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
          max-h-[90vh] overflow-y-auto
          sm:max-w-lg
        `}
      >
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit 90-day notification" : "New 90-day notification"}
          </DialogTitle>
          <DialogDescription>
            TM.47 reporting tracker. Due date and reminders are computed from
            the last arrival date.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            id="ninety-day-form"
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
          >
            <FormField
              control={form.control}
              name="employeeId"
              render={({ field }) => {
                const holderType = form.watch("holderType");
                const isOther = holderType === "dependent";
                const selectValue = isOther ? "__other__" : field.value || "";
                return (
                  <FormItem>
                    <FormLabel>Applicant *</FormLabel>
                    <Select
                      value={selectValue}
                      onValueChange={(next) => {
                        if (next === "__other__") {
                          form.setValue("holderType", "dependent", {
                            shouldDirty: true,
                          });
                          field.onChange("");
                        } else {
                          form.setValue("holderType", "employee", {
                            shouldDirty: true,
                          });
                          form.setValue("holderName", "", {
                            shouldDirty: true,
                          });
                          form.setValue("holderRelationship", "", {
                            shouldDirty: true,
                          });
                          field.onChange(next);
                        }
                      }}
                      disabled={isEditing || employeesLoading}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue
                            placeholder={
                              employeesLoading ? "Loading…" : "Select applicant"
                            }
                          />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {employees.map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.name}
                            {u.email && (
                              <span
                                className={`text-muted-foreground ml-2 text-xs`}
                              >
                                {u.email}
                              </span>
                            )}
                          </SelectItem>
                        ))}
                        <SelectItem value="__other__">
                          Other (non-employee / dependent)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    {isOther && (
                      <p className="text-muted-foreground mt-1 text-[11px]">
                        For a non-employee applicant — spouse, child, parent —
                        whose 90-day filing we track. Fill in the holder name
                        and pick a sponsor employee so reminders still route to
                        a Manut inbox.
                      </p>
                    )}
                    <FormMessage />
                  </FormItem>
                );
              }}
            />

            {form.watch("holderType") === "dependent" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="holderName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Holder name *</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. Jane Parikh" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="holderRelationship"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Relationship</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="spouse, child, parent…"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="employeeId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sponsor employee *</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                        disabled={isEditing || employeesLoading}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue
                              placeholder={
                                employeesLoading
                                  ? "Loading…"
                                  : "Select sponsor employee"
                              }
                            />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {employees.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                              {u.name}
                              {u.email && (
                                <span
                                  className={`
                                    text-muted-foreground ml-2 text-xs
                                  `}
                                >
                                  {u.email}
                                </span>
                              )}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {entities.length > 0 && (
              <FormField
                control={form.control}
                name="entityId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Entity</FormLabel>
                    <Select
                      value={field.value || NO_ENTITY}
                      onValueChange={(v) =>
                        field.onChange(v === NO_ENTITY ? "" : v)
                      }
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="No entity" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NO_ENTITY}>No entity</SelectItem>
                        {entities.map((e) => (
                          <SelectItem key={e.id} value={e.id}>
                            {e.name} ({e.code})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="lastArrivalDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Last arrival date *</FormLabel>
                  <FormControl>
                    <FormDatePicker
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="Pick a date"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {NINETY_DAY_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {NINETY_DAY_STATUS_LABELS[s]}
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
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Optional remarks for HR"
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="receipt"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <ReceiptUploadField
                      receipt={field.value}
                      onChange={field.onChange}
                      disabled={submitting}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" form="ninety-day-form" disabled={submitting}>
            {submitting ? "Saving…" : isEditing ? "Save changes" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
