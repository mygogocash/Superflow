"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  Loader2,
  Paperclip,
  Sparkles,
  Trash2,
  UploadCloud,
} from "lucide-react";
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
import { VisaOcrConfirmDialog } from "@/components/visa/visa-ocr-confirm-dialog";
import { ApiError } from "@/lib/api-client";
import { type Entity, listEntities } from "@/services/entity.service";
import { uploadFile } from "@/services/upload.service";
import { listUsers, type UserListItem } from "@/services/user.service";
import {
  createVisa,
  parseVisaScan,
  updateVisa,
  VISA_DOCUMENT_CATEGORIES,
  VISA_DOCUMENT_CATEGORY_LABELS,
  VISA_STATUS_LABELS,
  VISA_STATUSES,
  VISA_TYPE_LABELS,
  VISA_TYPES,
  type VisaDocument,
  type VisaDocumentCategory,
  type VisaParseResult,
  type VisaRecord,
} from "@/services/visa.service";

// Categories worth running OCR on. "other" is excluded — it's a catch-all
// for supporting docs, not an identity page.
const OCR_CATEGORIES = new Set<VisaDocumentCategory>([
  "passport_front",
  "visa_page",
  "work_permit",
]);

// Gemini vision can't read Apple HEIC/HEIF; the upload bucket accepts them.
function isOcrSupported(doc: VisaDocument | undefined): boolean {
  if (!doc) return false;
  const t = (doc.type ?? "").toLowerCase();
  if (t.includes("heic") || t.includes("heif")) return false;
  return true;
}

const NO_ENTITY = "__none__";

const documentSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  type: z.string().optional(),
  category: z.enum(VISA_DOCUMENT_CATEGORIES),
});

const formSchema = z
  .object({
    holderType: z.enum(["employee", "dependent"]),
    employeeId: z.string().uuid("Pick an employee from the list"),
    holderName: z.string().max(200).optional().or(z.literal("")),
    holderRelationship: z.string().max(60).optional().or(z.literal("")),
    visaType: z.string().min(1, "Visa type is required"),
    country: z.string().min(1, "Country of issue is required").max(100),
    nationality: z.string().max(100).optional().or(z.literal("")),
    issueDate: z.string().optional().or(z.literal("")),
    expiryDate: z.string().min(1, "Expiry date is required"),
    workPermitNumber: z.string().max(100).optional().or(z.literal("")),
    workPermitIssueDate: z.string().optional().or(z.literal("")),
    workPermitExpiryDate: z.string().optional().or(z.literal("")),
    status: z.string().min(1, "Status is required"),
    documents: z.array(documentSchema).max(20),
    notes: z.string().max(2000).optional().or(z.literal("")),
    entityId: z.string().optional().or(z.literal("")),
  })
  .refine(
    (data) =>
      data.holderType !== "dependent" ||
      (data.holderName ?? "").trim().length > 0,
    {
      message: "Holder name is required for a dependent record",
      path: ["holderName"],
    },
  )
  .refine(
    (data) => {
      const issue = data.issueDate?.trim();
      if (!issue) return true;
      return data.expiryDate >= issue;
    },
    {
      message: "Expiry date must not be before issue date",
      path: ["expiryDate"],
    },
  )
  .refine(
    (data) => {
      const issue = data.workPermitIssueDate?.trim();
      const expiry = data.workPermitExpiryDate?.trim();
      if (!issue || !expiry) return true;
      return expiry >= issue;
    },
    {
      message: "Work permit expiry must not be before issue date",
      path: ["workPermitExpiryDate"],
    },
  );

type FormValues = z.infer<typeof formSchema>;

interface VisaFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  visa?: VisaRecord | null;
  onSaved: (saved: VisaRecord) => void;
}

interface UploadSlotProps {
  category: VisaDocumentCategory;
  document: VisaDocument | undefined;
  onChange: (next: VisaDocument | undefined) => void;
  onExtracted?: (result: VisaParseResult) => void;
  disabled?: boolean;
}

function UploadSlot({
  category,
  document: doc,
  onChange,
  onExtracted,
  disabled,
}: UploadSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState(false);

  const canExtract =
    !!onExtracted &&
    !!doc &&
    OCR_CATEGORIES.has(category) &&
    isOcrSupported(doc);

  async function handleExtract() {
    if (!doc || !onExtracted) return;
    try {
      setExtracting(true);
      const res = await parseVisaScan(doc.url, category);
      onExtracted(res.data);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Couldn't read the document",
      );
    } finally {
      setExtracting(false);
    }
  }

  async function handleFile(file: File) {
    if (!file) return;
    try {
      setUploading(true);
      const result = await uploadFile(file, {
        bucket: "documents",
        purpose: "visa-document",
      });
      onChange({
        name: result.originalName,
        url: result.url,
        type: result.mimeType,
        category,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div
      className={`
        border-border/60 flex items-center justify-between gap-2 rounded-md
        border p-2
      `}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <Paperclip className="text-muted-foreground size-3.5 shrink-0" />
        <div className="min-w-0">
          <div className="text-foreground truncate font-medium">
            {VISA_DOCUMENT_CATEGORY_LABELS[category]}
            {category !== "other" ? "" : " (optional)"}
          </div>
          {doc ? (
            <a
              href={doc.url}
              target="_blank"
              rel="noreferrer noopener"
              className={`
                text-primary truncate text-xs
                hover:underline
              `}
            >
              {doc.name}
            </a>
          ) : (
            <div className="text-muted-foreground text-xs">No file</div>
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
        {canExtract ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || uploading || extracting}
            onClick={handleExtract}
            title="Extract fields from this scan with AI"
          >
            {extracting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            Extract fields
          </Button>
        ) : null}
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
        </Button>
        {doc && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || uploading}
            onClick={() => onChange(undefined)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

export function VisaFormDialog({
  open,
  onOpenChange,
  visa,
  onSaved,
}: VisaFormDialogProps) {
  const isEditing = !!visa;
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
        // Entity picker is optional — non-admin roles without
        // admin:read / user:read just won't see the selector.
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      holderType: "employee",
      employeeId: "",
      holderName: "",
      holderRelationship: "",
      visaType: "",
      country: "",
      nationality: "",
      issueDate: "",
      expiryDate: "",
      workPermitNumber: "",
      workPermitIssueDate: "",
      workPermitExpiryDate: "",
      status: "pending",
      documents: [],
      notes: "",
      entityId: "",
    },
  });

  const issueDateWatch = form.watch("issueDate");
  const expiryDateWatch = form.watch("expiryDate");
  const wpIssueWatch = form.watch("workPermitIssueDate");
  const wpExpiryWatch = form.watch("workPermitExpiryDate");
  const documentsWatch = form.watch("documents");

  // OCR autofill — extracted fields await user confirmation before they
  // touch the form (never silently overwrite what HR already typed).
  const [ocrResult, setOcrResult] = useState<VisaParseResult | null>(null);
  const [ocrOpen, setOcrOpen] = useState(false);

  function applyOcr(selected: Partial<Record<keyof VisaParseResult, boolean>>) {
    if (!ocrResult) return;
    const r = ocrResult;
    const set = (field: keyof FormValues, value: string) => {
      if (value) {
        form.setValue(field, value, {
          shouldDirty: true,
          shouldValidate: true,
        });
      }
    };
    if (selected.country) set("country", r.country);
    if (selected.nationality) set("nationality", r.nationality);
    if (selected.issueDate) set("issueDate", r.issueDate);
    if (selected.expiryDate) set("expiryDate", r.expiryDate);
    if (selected.workPermitNumber) set("workPermitNumber", r.workPermitNumber);
    if (selected.workPermitIssueDate) {
      set("workPermitIssueDate", r.workPermitIssueDate);
    }
    if (selected.workPermitExpiryDate) {
      set("workPermitExpiryDate", r.workPermitExpiryDate);
    }
    // Holder name only maps to a form field for dependent records.
    if (selected.holderName && form.getValues("holderType") === "dependent") {
      set("holderName", r.holderName);
    }
  }

  useEffect(() => {
    if (!open) return;
    if (visa) {
      form.reset({
        holderType: visa.holderType ?? "employee",
        employeeId: visa.employeeId,
        holderName: visa.holderName ?? "",
        holderRelationship: visa.holderRelationship ?? "",
        visaType: visa.visaType,
        country: visa.country,
        nationality: visa.nationality ?? "",
        issueDate: visa.issueDate ? String(visa.issueDate).slice(0, 10) : "",
        expiryDate: String(visa.expiryDate).slice(0, 10),
        workPermitNumber: visa.workPermitNumber ?? "",
        workPermitIssueDate: visa.workPermitIssueDate
          ? String(visa.workPermitIssueDate).slice(0, 10)
          : "",
        workPermitExpiryDate: visa.workPermitExpiryDate
          ? String(visa.workPermitExpiryDate).slice(0, 10)
          : "",
        status: visa.status,
        documents: Array.isArray(visa.documents) ? visa.documents : [],
        notes: visa.notes ?? "",
        entityId: visa.entityId ?? "",
      });
    } else {
      form.reset({
        holderType: "employee",
        employeeId: "",
        holderName: "",
        holderRelationship: "",
        visaType: "",
        country: "",
        nationality: "",
        issueDate: "",
        expiryDate: "",
        workPermitNumber: "",
        workPermitIssueDate: "",
        workPermitExpiryDate: "",
        status: "pending",
        documents: [],
        notes: "",
        entityId: "",
      });
    }
  }, [open, visa, form]);

  function setDocumentForCategory(
    category: VisaDocumentCategory,
    next: VisaDocument | undefined,
  ) {
    const existing = documentsWatch ?? [];
    const without = existing.filter((d) => d.category !== category);
    const merged = next ? [...without, next] : without;
    form.setValue("documents", merged, { shouldDirty: true });
  }

  function docFor(category: VisaDocumentCategory) {
    return (documentsWatch ?? []).find((d) => d.category === category);
  }

  async function onSubmit(values: FormValues) {
    try {
      setSubmitting(true);
      const payload = {
        employeeId: values.employeeId,
        holderType: values.holderType,
        holderName:
          values.holderType === "dependent"
            ? values.holderName || undefined
            : undefined,
        holderRelationship:
          values.holderType === "dependent"
            ? values.holderRelationship || undefined
            : undefined,
        visaType: values.visaType,
        country: values.country,
        nationality: values.nationality || undefined,
        issueDate: values.issueDate || undefined,
        expiryDate: values.expiryDate,
        workPermitNumber: values.workPermitNumber || undefined,
        workPermitIssueDate: values.workPermitIssueDate || undefined,
        workPermitExpiryDate: values.workPermitExpiryDate || undefined,
        status: values.status,
        documents: values.documents,
        notes: values.notes || undefined,
        entityId: values.entityId || undefined,
      };

      if (isEditing) {
        const res = await updateVisa(visa.id, payload);
        toast.success("Visa record updated");
        onSaved(res.data);
      } else {
        const res = await createVisa(payload);
        toast.success("Visa record created");
        onSaved(res.data);
      }
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        const details = err.details ?? [];
        if (details.length > 0) {
          const firstField = details[0]?.field;
          const firstMessage = details[0]?.message;
          toast.error(
            firstField
              ? `${err.message}: ${firstField} — ${firstMessage}`
              : `${err.message}: ${firstMessage}`,
          );
        } else {
          toast.error(`${err.message} [${err.status} ${err.code}]`);
        }
      } else {
        toast.error(
          err instanceof Error ? err.message : "Something went wrong",
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!submitting) onOpenChange(next);
        }}
      >
        <DialogContent
          className={`
            max-h-[92vh] overflow-y-auto
            sm:max-w-xl
          `}
        >
          <DialogHeader>
            <DialogTitle>
              {isEditing ? "Edit visa record" : "New visa record"}
            </DialogTitle>
            <DialogDescription>
              {isEditing
                ? "Update this visa record."
                : "Add a new visa record for an employee."}
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
              id="visa-form"
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
                      <FormLabel>Employee *</FormLabel>
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
                                employeesLoading
                                  ? "Loading…"
                                  : "Select employee"
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
                          <SelectItem value="__other__">
                            Other (non-employee / dependent)
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {isOther && (
                        <p className="text-muted-foreground mt-1 text-[11px]">
                          For an expat dependent — spouse, child, parent — whose
                          visa we track even though they are not an employee.
                          Fill in the holder name below and pick a sponsor
                          employee so reminders still route to a Manut inbox.
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

              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="visaType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Visa type *</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {VISA_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {VISA_TYPE_LABELS[t]}
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
                  name="country"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Country of Issue *</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Thailand" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="nationality"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Nationality</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="e.g. Thai, Indian, American"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

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
                              <SelectValue placeholder="Select entity" />
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
              </div>

              <div className="border-border/60 rounded-md border p-3">
                <div className="text-foreground mb-2 text-sm font-semibold">
                  Visa validity
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="issueDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Issue date</FormLabel>
                        <FormControl>
                          <FormDatePicker
                            {...field}
                            maxDate={expiryDateWatch?.trim() || undefined}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="expiryDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Expiry date *</FormLabel>
                        <FormControl>
                          <FormDatePicker
                            {...field}
                            minDate={issueDateWatch?.trim() || undefined}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              <div className="border-border/60 rounded-md border p-3">
                <div className="text-foreground mb-2 text-sm font-semibold">
                  Work permit (optional)
                </div>
                <FormField
                  control={form.control}
                  name="workPermitNumber"
                  render={({ field }) => (
                    <FormItem className="mb-3">
                      <FormLabel>Permit number</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. WP-12345" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="workPermitIssueDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Issue date</FormLabel>
                        <FormControl>
                          <FormDatePicker
                            {...field}
                            maxDate={wpExpiryWatch?.trim() || undefined}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="workPermitExpiryDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Expiry date</FormLabel>
                        <FormControl>
                          <FormDatePicker
                            {...field}
                            minDate={wpIssueWatch?.trim() || undefined}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status *</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select status" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {VISA_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {VISA_STATUS_LABELS[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="border-border/60 rounded-md border p-3">
                <div className="text-foreground mb-2 text-sm font-semibold">
                  Documents
                </div>
                <p className="text-muted-foreground mb-3 text-xs">
                  Upload passport front page, visa page, work permit, and any
                  other supporting documents. PDF or images, max 50&nbsp;MB
                  each.
                </p>
                <div className="flex flex-col gap-2">
                  {VISA_DOCUMENT_CATEGORIES.map((cat) => (
                    <UploadSlot
                      key={cat}
                      category={cat}
                      document={docFor(cat)}
                      onChange={(next) => setDocumentForCategory(cat, next)}
                      onExtracted={(result) => {
                        setOcrResult(result);
                        setOcrOpen(true);
                      }}
                      disabled={submitting}
                    />
                  ))}
                </div>
              </div>

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Additional notes…"
                        rows={2}
                        {...field}
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
            <Button
              type="submit"
              form="visa-form"
              disabled={submitting}
              className="min-w-32"
            >
              {submitting && <Loader2 className="mr-2 size-3.5 animate-spin" />}
              {isEditing ? "Save changes" : "Create record"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <VisaOcrConfirmDialog
        open={ocrOpen}
        onOpenChange={setOcrOpen}
        result={ocrResult}
        canApplyHolderName={form.watch("holderType") === "dependent"}
        onApply={applyOcr}
      />
    </>
  );
}
