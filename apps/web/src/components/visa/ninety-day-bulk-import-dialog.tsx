"use client";

import { Download, FileUp, Loader2, UploadCloud } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import * as XLSX from "xlsx";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api-client";
import {
  commitNinetyDayImport,
  type NinetyDayImportPreview,
  previewNinetyDayImport,
} from "@/services/ninety-day.service";

const TEMPLATE_HEADERS = [
  "Employee Name",
  "Email",
  "employeeId",
  "lastArrivalDate",
  "status",
  "notes",
];

const TEMPLATE_SAMPLE_ROWS = [
  [
    "Kunanon Jarat",
    "kunanon@manut.xyz",
    "MNT-001",
    "2026-02-14",
    "pending",
    "Returned from Singapore on the 14th — TM.47 due 15 May",
  ],
];

interface NinetyDayBulkImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
}

export function NinetyDayBulkImportDialog({
  open,
  onOpenChange,
  onImported,
}: NinetyDayBulkImportDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<NinetyDayImportPreview | null>(null);
  const [committed, setCommitted] = useState<{ imported: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null);
    setPreview(null);
    setCommitted(null);
    setParsing(false);
    setSubmitting(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function downloadTemplate(format: "xlsx" | "csv") {
    const data = [TEMPLATE_HEADERS, ...TEMPLATE_SAMPLE_ROWS];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "90 Day Notifications");
    XLSX.writeFile(
      wb,
      format === "xlsx"
        ? "ninety-day-import-template.xlsx"
        : "ninety-day-import-template.csv",
      format === "csv" ? { bookType: "csv" } : undefined,
    );
  }

  async function parseFile(f: File): Promise<Array<Record<string, unknown>>> {
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error("Spreadsheet has no sheets");
    const ws = wb.Sheets[sheetName];
    if (!ws) throw new Error("First sheet is empty");
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
      defval: "",
      raw: false,
    });
    if (rows.length === 0) {
      throw new Error("Sheet has no data rows");
    }
    return rows;
  }

  async function handlePreview() {
    if (!file) return;
    try {
      setParsing(true);
      setPreview(null);
      setCommitted(null);
      const rows = await parseFile(file);
      const res = await previewNinetyDayImport(rows);
      setPreview(res.data);
      if (res.data.errorCount > 0) {
        toast.error(
          `${res.data.errorCount} ${
            res.data.errorCount === 1 ? "row" : "rows"
          } have errors — fix and re-upload`,
        );
      } else {
        toast.success(
          `Ready to import ${res.data.validCount} ${
            res.data.validCount === 1 ? "row" : "rows"
          }`,
        );
      }
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to parse file";
      toast.error(message);
    } finally {
      setParsing(false);
    }
  }

  async function handleCommit() {
    if (!file || !preview) return;
    if (preview.errorCount > 0) {
      toast.error("Fix the errors first");
      return;
    }
    try {
      setSubmitting(true);
      const rows = await parseFile(file);
      const res = await commitNinetyDayImport(rows);
      setCommitted({ imported: res.data.imported });
      toast.success(
        `Imported ${res.data.imported} ${
          res.data.imported === 1 ? "notification" : "notifications"
        }`,
      );
      onImported?.();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to import";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting || parsing) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent
        className={`
          max-h-[92vh] overflow-y-auto
          sm:max-w-2xl
        `}
      >
        <DialogHeader>
          <DialogTitle>Bulk import 90-day notifications</DialogTitle>
          <DialogDescription>
            Upload an XLSX or CSV file with TM.47 records. The importer derives
            the due date from the last arrival date (89 days after arrival).
          </DialogDescription>
        </DialogHeader>

        <section className="flex flex-col gap-3">
          <p
            className={`
              text-muted-foreground text-[10px] font-bold tracking-widest
              uppercase
            `}
          >
            Step 1 — download template
          </p>
          <p className="text-muted-foreground text-xs">
            Required: <span className="font-mono">lastArrivalDate</span>{" "}
            (YYYY-MM-DD), and at least one of{" "}
            <span className="font-mono">Employee Name</span>,{" "}
            <span className="font-mono">Email</span>, or{" "}
            <span className="font-mono">employeeId</span> (UUID or staff code
            like <span className="font-mono">MNT-001</span>). Optional:{" "}
            <span className="font-mono">status</span> (pending / to_be_notifying
            / approved / no_required — defaults to pending),{" "}
            <span className="font-mono">notes</span>.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadTemplate("xlsx")}
            >
              <Download className="size-3.5" />
              Download XLSX template
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadTemplate("csv")}
            >
              <Download className="size-3.5" />
              Download CSV template
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <p
            className={`
              text-muted-foreground text-[10px] font-bold tracking-widest
              uppercase
            `}
          >
            Step 2 — upload file
          </p>
          <label
            htmlFor="ninety-day-import-file"
            className={`
              border-border text-muted-foreground flex cursor-pointer flex-col
              items-center justify-center gap-1 rounded-md border border-dashed
              p-6 text-center text-xs
              hover:border-foreground/30
              ${file ? "border-primary/40 bg-primary/5" : ""}
            `}
          >
            <UploadCloud className="size-6" />
            {file ? (
              <>
                <span className="text-foreground font-medium">{file.name}</span>
                <span>
                  {(file.size / 1024).toFixed(1)} KB — click to choose a
                  different file
                </span>
              </>
            ) : (
              <>
                <span className="text-foreground font-medium">
                  Click to choose a file
                </span>
                <span>.xlsx, .csv — up to 5 MB</span>
              </>
            )}
            <input
              ref={fileInputRef}
              id="ninety-day-import-file"
              type="file"
              accept=".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              className="hidden"
              onChange={(e) => {
                const next = e.target.files?.[0] ?? null;
                setFile(next);
                setPreview(null);
                setCommitted(null);
              }}
            />
          </label>
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void handlePreview()}
              disabled={!file || parsing || submitting}
            >
              {parsing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FileUp className="size-3.5" />
              )}
              Preview rows
            </Button>
          </div>
        </section>

        {preview ? (
          <section className="flex flex-col gap-2">
            <p
              className={`
                text-muted-foreground text-[10px] font-bold tracking-widest
                uppercase
              `}
            >
              Preview report
            </p>
            <div className="flex gap-3 text-xs">
              <span className="text-foreground">
                Total rows:{" "}
                <span className="font-semibold">{preview.totalRows}</span>
              </span>
              <span className="text-emerald-600">
                Valid:{" "}
                <span className="font-semibold">{preview.validCount}</span>
              </span>
              <span className="text-destructive">
                Errors:{" "}
                <span className="font-semibold">{preview.errorCount}</span>
              </span>
            </div>
            {preview.errors.length > 0 ? (
              <ul
                className={`
                  border-border max-h-60 divide-y overflow-y-auto rounded-md
                  border
                `}
              >
                {preview.errors.map((e) => (
                  <li
                    key={`${e.row}-${e.message}`}
                    className={`
                      flex items-start justify-between gap-3 px-3 py-1.5 text-xs
                    `}
                  >
                    <span className="text-muted-foreground tabular-nums">
                      Row {e.row}
                    </span>
                    <span
                      className={`text-destructive flex-1 truncate text-right`}
                    >
                      {e.message}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {committed ? (
          <p className="text-xs text-emerald-600">
            Imported {committed.imported} 90-day notification
            {committed.imported === 1 ? "" : "s"}.
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting || parsing}
          >
            Close
          </Button>
          <Button
            type="button"
            onClick={() => void handleCommit()}
            disabled={
              !preview ||
              preview.errorCount > 0 ||
              submitting ||
              parsing ||
              !!committed
            }
          >
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FileUp className="size-3.5" />
            )}
            Import {preview ? `${preview.validCount} rows` : "rows"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
