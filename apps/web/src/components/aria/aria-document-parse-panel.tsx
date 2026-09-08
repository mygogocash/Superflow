"use client";

import { Copy, FileUp, Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type AriaParsedInvoice,
  type AriaParsedReceipt,
  parseAriaInvoice,
  parseAriaReceipt,
} from "@/services/aria.service";

type DocKind = "receipt" | "invoice";

const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf,.pdf";

export function AriaDocumentParsePanel() {
  const [kind, setKind] = useState<DocKind>("receipt");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [receipt, setReceipt] = useState<AriaParsedReceipt | null>(null);
  const [invoice, setInvoice] = useState<AriaParsedInvoice | null>(null);

  const activeResult = kind === "receipt" ? receipt : invoice;

  const onKindChange = (v: string) => {
    const next = v === "invoice" ? "invoice" : "receipt";
    setKind(next);
    setFile(null);
    setReceipt(null);
    setInvoice(null);
  };

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setFile(f ?? null);
    setReceipt(null);
    setInvoice(null);
    e.target.value = "";
  };

  const runParse = useCallback(async () => {
    if (!file) {
      toast.error("Choose a file first");
      return;
    }
    setLoading(true);
    try {
      if (kind === "receipt") {
        const data = await parseAriaReceipt(file);
        setReceipt(data);
        setInvoice(null);
        toast.success("Receipt parsed");
      } else {
        const data = await parseAriaInvoice(file);
        setInvoice(data);
        setReceipt(null);
        toast.success("Invoice parsed");
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not parse document";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [file, kind]);

  const copyJson = useCallback(async () => {
    if (!activeResult) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(activeResult, null, 2),
      );
      toast.success("Copied JSON");
    } catch {
      toast.error("Copy failed");
    }
  }, [activeResult]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <Tabs value={kind} onValueChange={onKindChange}>
        <TabsList className="w-full max-w-md" variant="line">
          <TabsTrigger value="receipt" className="flex-1">
            Receipt
          </TabsTrigger>
          <TabsTrigger value="invoice" className="flex-1">
            Invoice
          </TabsTrigger>
        </TabsList>

        <TabsContent value="receipt" className="mt-4 space-y-4">
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            Upload a photo or PDF of a payment receipt. Manut AI extracts totals,
            merchant, and suggested wording for an expense line — always verify
            before submitting.
          </p>
        </TabsContent>
        <TabsContent value="invoice" className="mt-4 space-y-4">
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            Upload a vendor invoice (PDF or scan). Fields are extracted for
            review; they are not posted to accounting automatically.
          </p>
        </TabsContent>
      </Tabs>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Upload</CardTitle>
          <CardDescription className="text-xs">
            JPEG, PNG, WebP, or PDF — max 12 MB.
          </CardDescription>
        </CardHeader>
        <CardContent
          className={`
            flex flex-col gap-3
            sm:flex-row sm:items-center
          `}
        >
          <label className="inline-flex cursor-pointer">
            <input
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={onFilePick}
            />
            <span
              className={`
                border-border bg-background inline-flex items-center gap-2
                rounded-lg border px-3 py-2 text-sm font-medium
                hover:bg-muted/60
              `}
            >
              <FileUp className="text-muted-foreground size-4" />
              {file ? file.name : "Choose file"}
            </span>
          </label>
          <Button
            type="button"
            disabled={!file || loading}
            onClick={() => void runParse()}
            className="sm:ml-auto"
          >
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Parsing…
              </>
            ) : (
              "Extract with AI"
            )}
          </Button>
        </CardContent>
      </Card>

      {activeResult && (
        <Card>
          <CardHeader
            className={`flex flex-row items-start justify-between gap-2 pb-2`}
          >
            <div>
              <CardTitle className="text-base">Result</CardTitle>
              <CardDescription className="text-xs">
                {kind === "receipt"
                  ? (activeResult as AriaParsedReceipt).parsingNotes
                  : (activeResult as AriaParsedInvoice).parsingNotes}
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={() => void copyJson()}
            >
              <Copy className="size-3.5" />
              JSON
            </Button>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {kind === "receipt" ? (
              <ReceiptFields data={activeResult as AriaParsedReceipt} />
            ) : (
              <InvoiceFields data={activeResult as AriaParsedInvoice} />
            )}
            <p
              className={`
                text-muted-foreground border-border border-t pt-3 text-xs
              `}
            >
              Use this as a starting point on{" "}
              <Link
                href="/expenses"
                className={`
                  text-primary font-medium underline-offset-2
                  hover:underline
                `}
              >
                Expenses
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: string | number | undefined | null;
}) {
  const v =
    value === undefined || value === null || value === ""
      ? "—"
      : typeof value === "number"
        ? value.toLocaleString(undefined, {
            maximumFractionDigits: 2,
          })
        : String(value);
  return (
    <div
      className={`
        grid grid-cols-[minmax(0,38%)] gap-x-3
        sm:grid-cols-[140px_1fr]
      `}
    >
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd
        className={`
          text-foreground text-xs break-words
          sm:text-sm
        `}
      >
        {v}
      </dd>
    </div>
  );
}

function ReceiptFields({ data }: { data: AriaParsedReceipt }) {
  return (
    <dl className="grid gap-2">
      <Field label="Merchant" value={data.merchantName} />
      <Field label="Date" value={data.transactionDate} />
      <Field label="Currency" value={data.currency} />
      <Field label="Total" value={data.totalAmount} />
      <Field label="Tax" value={data.taxAmount} />
      {data.subtotal != null && (
        <Field label="Subtotal" value={data.subtotal} />
      )}
      <Field label="Payment" value={data.paymentMethod} />
      <Field label="Suggested description" value={data.suggestedDescription} />
      {data.lineItems.length > 0 && (
        <div className="pt-1">
          <p className="text-muted-foreground mb-1 text-xs font-medium">
            Line items
          </p>
          <ul
            className={`
              text-foreground list-inside list-disc space-y-0.5 text-xs
            `}
          >
            {data.lineItems.map((line, i) => (
              <li key={`${line.description}-${i}`}>
                {line.description}
                {line.amount != null ? ` — ${line.amount}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </dl>
  );
}

function InvoiceFields({ data }: { data: AriaParsedInvoice }) {
  return (
    <dl className="grid gap-2">
      <Field label="Vendor" value={data.vendorName} />
      <Field label="Tax ID" value={data.vendorTaxId} />
      <Field label="Invoice #" value={data.invoiceNumber} />
      <Field label="Issue date" value={data.issueDate} />
      <Field label="Due date" value={data.dueDate} />
      <Field label="Currency" value={data.currency} />
      <Field label="Total" value={data.totalAmount} />
      <Field label="Tax" value={data.taxAmount} />
      <Field label="Suggested memo" value={data.suggestedMemo} />
      {data.lineItems.length > 0 && (
        <div className="pt-1">
          <p className="text-muted-foreground mb-1 text-xs font-medium">
            Line items
          </p>
          <ul
            className={`
              text-foreground list-inside list-disc space-y-0.5 text-xs
            `}
          >
            {data.lineItems.map((line, i) => (
              <li key={`${line.description}-${i}`}>
                {line.description}
                {line.amount != null ? ` — ${line.amount}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </dl>
  );
}
