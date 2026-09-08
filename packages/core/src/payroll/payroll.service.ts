import type { Db } from "@nexora/db";
import { PERMISSIONS } from "@nexora/contracts";
import type {
  ConsultantInvoiceQuery,
  CreateConsultantInvoiceInput,
  CreatePayrollRunInput,
  CreatePayslipInput,
  HrPayslipQuery,
  PayrollRunQuery,
  PayslipCompanyInput,
  PrepareImportRunInput,
  UpdatePayslipInput,
} from "@nexora/contracts/modules/payroll/payroll.validation";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "../http-exception";
import { rowsToCsv } from "../lib/csv";
import { APP_NAME_SETTING_KEY, orgNameFromSetting } from "../lib/org";
import { getSetting, upsertSetting } from "../survey/system-settings.repository";
import {
  R2_PRIVATE_PREFIX,
  parseR2PrivateKey,
} from "../certificates/certificates.service";
import { resolveRate } from "./payroll.fx";
import * as repo from "./payroll.repository";
import {
  buildBulkPayslipZip,
  buildPayslipPdfBuffer,
  buildPayslipWorkbookBuffer,
  type ExportFormat,
  type PayslipExportInput,
} from "./payslip-generator";

export type PayrollStorage = {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
};

function notifyPayrollApproved(_runId: string, _approverId: string): void {}
function notifyPayrollRunCreated(_runId: string, _userId: string): void {}

interface AllowanceDeductionBreakdown {
  meal: number;
  transportation: number;
  telephone: number;
  // May-2026 template adds House Allowance and renames Wifi (India
  // Team) → Internet Bills + Telephone → Phone Allowance. The legacy
  // `wifi` key is kept for backward compatibility with older rows that
  // already serialised under that shape.
  house: number;
  internet: number;
  overtime: number;
  wifi: number;
  otherIncome: number;
  reimbursement: number;
  flatAllowance: number;
  tax: number;
  ssf: number;
  otherDeduction: number;
  flatDeduction: number;
}

function pickString(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s.length > 0) return s;
  }
  return "";
}

/**
 * Coerce a spreadsheet cell to a number. Excel/SheetJS hand back values
 * like `" 300,000.00 "` for currency-formatted columns — `Number(...)`
 * on that string is NaN because of the thousands separator and the
 * surrounding whitespace, which made HR's template produce "Missing or
 * invalid base salary" for every row. Strip non-numeric noise first.
 */
function coerceNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // Trim, drop NBSP / thin space, drop currency symbols, drop digit
  // group separators (commas + apostrophes). Keep the sign and dot.
  const cleaned = String(v)
    .replace(/\s/g, "")
    .replace(/[,'_]/g, "")
    .replace(/[^\d.\-+eE]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === "+") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function pickNumber(row: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const n = coerceNumber(row[k]);
    if (n !== null) return n;
  }
  return 0;
}

function normaliseName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Sort the tokens of a name so "Tran Van Hai" and "Hai Tran Van" hash
 * to the same key. Lets HR spreadsheets that flip surname/given-name
 * order still resolve to the right user without manual editing.
 */
function tokenSetKey(s: string): string {
  return normaliseName(s).split(" ").filter(Boolean).sort().join(" ");
}

/**
 * Resolve a parsed import row to a user. Tries — in order — id lookup,
 * email lookup, exact normalised name match, then token-set match (any
 * order of given/surname tokens). Returns `undefined` if no candidate
 * fits or if the token-set match is ambiguous.
 */
function matchImportRowToUser<
  T extends { id: string; name: string; email: string },
>(
  row: {
    employeeId?: string;
    employeeEmail?: string;
    employeeName?: string;
  },
  byId: Map<string, T>,
  byEmail: Map<string, T>,
  byNormalisedName: Map<string, T>,
  byTokenSet: Map<string, T[]>,
): T | undefined {
  if (row.employeeId) {
    const hit = byId.get(row.employeeId);
    if (hit) return hit;
  }
  if (row.employeeEmail) {
    const hit = byEmail.get(row.employeeEmail.toLowerCase());
    if (hit) return hit;
  }
  if (row.employeeName) {
    const exact = byNormalisedName.get(normaliseName(row.employeeName));
    if (exact) return exact;
    const tokenHits = byTokenSet.get(tokenSetKey(row.employeeName));
    if (tokenHits && tokenHits.length === 1) return tokenHits[0];
  }
  return undefined;
}

// Admin-managed company legal block printed in the payslip footer. Stored as a
// single global SystemSetting; the legal name defaults to the organization name
// from admin setup (`app.name`) and the address / phone are left blank until
// entered in Payslip Management, so the footer follows the org rather than a
// hardcoded legal entity.
const PAYSLIP_COMPANY_KEY = "payslip.company";
export interface PayslipCompany {
  legalName: string;
  address: string;
  phone: string;
}
function buildDefaultPayslipCompany(orgName: string): PayslipCompany {
  return { legalName: orgName, address: "", phone: "" };
}



  /** Read the global payslip company block (falls back to the org default). */
export async function getPayslipCompany(db: Db): Promise<PayslipCompany> {
    const [value, appName] = await Promise.all([
      getSetting(db, PAYSLIP_COMPANY_KEY),
      getSetting(db, APP_NAME_SETTING_KEY),
    ]);
    const fallback = buildDefaultPayslipCompany(orgNameFromSetting(appName));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const v = value as Record<string, unknown>;
      return {
        legalName:
          typeof v.legalName === "string" ? v.legalName : fallback.legalName,
        address: typeof v.address === "string" ? v.address : fallback.address,
        phone: typeof v.phone === "string" ? v.phone : fallback.phone,
      };
    }
    return fallback;
  }

  /** Admin upsert of the global payslip company block. */
export async function setPayslipCompany(db: Db, input: PayslipCompanyInput): Promise<PayslipCompany> {
    const legalName = (input.legalName ?? "").trim();
    const address = (input.address ?? "").trim();
    const phone = (input.phone ?? "").trim();
    await upsertSetting(db, PAYSLIP_COMPANY_KEY, { legalName, address, phone });
    return { legalName, address, phone };
  }

  /**
   * Plain employees with `payroll:read` only see runs that contain
   * their own payslip — and inside the detail view, only their own
   * payslip row. HR/admin holders (`payroll:create`, `payroll:approve`,
   * `payroll:hr-admin`) see the full company ledger.
   */
  function isPayrollManager(actorPermissions: string[]): boolean {
    return (
      actorPermissions.includes(PERMISSIONS.PAYROLL_CREATE) ||
      actorPermissions.includes(PERMISSIONS.PAYROLL_APPROVE) ||
      actorPermissions.includes(PERMISSIONS.PAYROLL_HR_ADMIN)
    );
  }

export async function listRuns(db: Db, 
    query: PayrollRunQuery,
    actorId: string,
    actorPermissions: string[],
  ) {
    const { page, limit, ...filters } = query;
    const canManage = isPayrollManager(actorPermissions);
    const scopedFilters = canManage
      ? filters
      : { ...filters, employeeIdScope: actorId };
    const { data, total } = await repo.findRuns(db, 
      scopedFilters,
      page,
      limit,
    );

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // Re-aggregate the run's headline totals from the persisted payslips,
  // converting every off-currency slip into the entity currency via the
  // latest exchange rates. Used to backfill runs created before the FX
  // headline fix landed, and from the "Recalculate totals" button on
  // the run detail sheet.
export async function recalculateRunTotals(db: Db, runId: string) {
    const run = await repo.findRunById(db, runId);
    if (!run) throw new NotFoundException("Payroll run not found");
    const recalc = await repo.sumPayslipTotalsForRun(db, runId);
    await repo.setRunTotals(db, runId, recalc);
    return {
      runId,
      totalGross: recalc.totalGross,
      totalNet: recalc.totalNet,
      totalTax: recalc.totalTax,
      currencyTotals: recalc.currencyTotals,
      missingFxFor: recalc.missingFxFor,
    };
  }

  // Returns the run with `entityCurrency` + per-payslip
  // `grossPayInEntityCurrency` / `netPayInEntityCurrency` / `fxRate`
  // attached. Lets the Run Details sheet render a "Total Payout (THB)"
  // column whose sum matches the FX-converted headline Total Net, so
  // HR doesn't have to eyeball three native-currency columns plus a
  // separately-summed headline.
  async function enrichPayslipsWithEntityCurrency<
    R extends {
      entity: { currency: string };
      payslips: Array<{
        grossPay: unknown;
        netPay: unknown;
        grossPayBase?: unknown;
        netPayBase?: unknown;
        currency: string;
      }>;
    },
  >(db: Db, run: R) {
    const entityCurrency = run.entity.currency;
    
    const payslips = await Promise.all(
      run.payslips.map(async (p) => {
        const gross = Number(p.grossPay ?? 0);
        const net = Number(p.netPay ?? 0);
        // BD-feedback (Vivek, May 2026) — when the bulk importer stored
        // HR's pre-converted equivalents we use them verbatim so the
        // "Total Payout (entityCurrency)" column in the detail sheet
        // matches the spreadsheet exactly and never depends on whether
        // an ExchangeRate row exists.
        if (p.netPayBase != null && p.grossPayBase != null) {
          const grossBase = Number(p.grossPayBase);
          const netBase = Number(p.netPayBase);
          return {
            ...p,
            grossPayInEntityCurrency: grossBase,
            netPayInEntityCurrency: netBase,
            fxRate: net > 0 ? netBase / net : null,
            fxSource: "import" as const,
            fxBridge: null,
          };
        }
        if (p.currency === entityCurrency) {
          return {
            ...p,
            grossPayInEntityCurrency: gross,
            netPayInEntityCurrency: net,
            fxRate: 1,
            fxSource: "identity" as const,
          };
        }
        const lookup = await resolveRate(db, p.currency, entityCurrency);
        const { rate, source } = lookup;
        if (source === "missing") {
          // Headline aggregation already logs the missing pair; the row
          // gets a null marker so the UI can show "—" instead of
          // pretending the conversion succeeded with a phantom 1:1 rate.
          return {
            ...p,
            grossPayInEntityCurrency: null,
            netPayInEntityCurrency: null,
            fxRate: null,
            fxSource: "missing" as const,
            fxBridge: null,
          };
        }
        return {
          ...p,
          grossPayInEntityCurrency: gross * rate,
          netPayInEntityCurrency: net * rate,
          fxRate: rate,
          fxSource: source,
          fxBridge: lookup.bridge ?? null,
        };
      }),
    );
    return { ...run, entityCurrency, payslips };
  }

export async function getRunById(db: Db, id: string, actorId: string, actorPermissions: string[]) {
    const run = await repo.findRunById(db, id);
    if (!run) throw new NotFoundException("Payroll run not found");
    if (isPayrollManager(actorPermissions)) {
      // Overlay fresh FX-aware totals on every detail open so HR doesn't
      // have to click "Recalculate totals" after each FX-rate change or
      // post-deploy. The aggregate is cheap (one Prisma read + N FX
      // lookups, all cached per-request via ExchangeRateService) and the
      // result is layered onto the in-memory run without writing to the
      // DB — explicit Recalculate stays for persisting headline values
      // that other surfaces (cron digest, list view) read.
      const fresh = await repo.sumPayslipTotalsForRun(db, id);
      const enriched = await enrichPayslipsWithEntityCurrency(db, run);
      return {
        ...enriched,
        totalGross: fresh.totalGross,
        totalNet: fresh.totalNet,
        totalTax: fresh.totalTax,
        currencyTotals: fresh.currencyTotals,
        missingFxFor: fresh.missingFxFor,
      };
    }
    // Plain employees: keep run metadata but show only their own payslip
    // line. If they have no payslip in this run, 404 — pretend it
    // doesn't exist rather than leaking the run's existence.
    const myPayslips = run.payslips.filter((p) => p.employeeId === actorId);
    if (myPayslips.length === 0) {
      throw new NotFoundException("Payroll run not found");
    }
    // Run-level totals are aggregated across all payslips and would
    // leak company-wide figures, so collapse them to the actor's slice.
    const myGross = myPayslips.reduce(
      (sum, p) => sum + Number(p.grossPay ?? 0),
      0,
    );
    const myNet = myPayslips.reduce((sum, p) => sum + Number(p.netPay ?? 0), 0);
    const sliced = await enrichPayslipsWithEntityCurrency(db, {
      ...run,
      payslips: myPayslips,
    });
    return {
      ...sliced,
      totalGross: myGross,
      totalNet: myNet,
      totalTax: myGross - myNet,
      // Plain employees should never see the run-wide currency rollup.
      currencyTotals: null,
    };
  }

export async function createRun(db: Db, userId: string, input: CreatePayrollRunInput) {
    const existing = await repo.findExistingRun(db, 
      input.entityId,
      input.period,
    );
    if (existing) {
      throw new ConflictException(
        `Payroll run already exists for entity ${input.entityId} period ${input.period}`,
      );
    }

    const employees = await repo.findEmployeesByEntity(db, 
      input.entityId,
      input.employeeId,
    );
    if (employees.length === 0) {
      throw new BadRequestException(
        input.employeeId
          ? "No active full-time employee found for this entity with the given ID"
          : "No active full-time employees found for this entity",
      );
    }


    const payslips = employees.map((emp) => {
      const baseSalary = Number(emp.salary ?? 0);
      const grossPay = baseSalary;
      const netPay = baseSalary;

      return {
        employeeId: emp.id,
        baseSalary,
        allowances: null,
        deductions: null,
        grossPay,
        netPay,
        currency: emp.currency ?? "USD",
      };
    });

    const result = await repo.createRunWithPayslips(db, 
      {
        entityId: input.entityId,
        period: input.period,
        runBy: userId,
        notes: input.notes,
      },
      payslips,
    );
    if (!result) {
      throw new BadRequestException("Failed to create payroll run");
    }

    // createRunWithPayslips stores a raw mixed-currency sum on the run
    // row. Re-aggregate with FX so the headline totals match the
    // entity currency across every payslip (THB + converted USD/INR
    // for a Thailand-entity run, etc.).
    const recalc = await repo.sumPayslipTotalsForRun(db, result.id);
    await repo.setRunTotals(db, result.id, recalc);


    return {
      ...result,
      totalGross: recalc.totalGross,
      totalNet: recalc.totalNet,
      totalTax: recalc.totalTax,
    };
  }

export async function approveRun(db: Db, runId: string, approverId: string) {
    const run = await repo.findRunById(db, runId);
    if (!run) throw new NotFoundException("Payroll run not found");
    if (run.status !== "draft") {
      throw new BadRequestException(
        `Cannot approve a run with status "${run.status}"`,
      );
    }

    return repo.approveRun(db, runId, approverId);
  }

  /**
   * HR-admin destructive delete. Drops the run and its payslips
   * (cascade). The 404 for unknown ids stays in the service so the
   * controller doesn't have to round-trip another findRunById.
   */
export async function deleteRun(db: Db, runId: string) {
    const run = await repo.findRunById(db, runId);
    if (!run) throw new NotFoundException("Payroll run not found");
    await repo.deleteRun(db, runId);
    return { id: runId };
  }

  /**
   * Inline-edit a single payslip inside a draft run. Approved/paid runs
   * are locked — HR has to revert them to draft (out of scope here) or
   * create a corrective run instead.
   *
   * If `grossPay` / `netPay` are not supplied the service recomputes
   * them from `baseSalary + sum(allowances) - sum(deductions)` so the
   * imported numbers stay consistent with HR's spreadsheet conventions
   * (`grossPay = base + allowances`, `netPay = gross - deductions`).
   *
   * Run-level totals (`totalGross`, `totalNet`, `totalTax`) are
   * re-aggregated from the surviving payslips after the update so the
   * summary card in the detail sheet stays in sync.
   */
  /**
   * HR's "+ New payslip" create. Computes gross/net from the parts
   * when the caller omits the totals (so the dialog can stay focused
   * on the structured Thai payroll fields and let the server roll up
   * the math). Locks the parent run to draft so committed runs don't
   * silently mutate.
   */
export async function createPayslip(db: Db, runId: string, input: CreatePayslipInput) {
    const run = await repo.findRunById(db, runId);
    if (!run) throw new NotFoundException("Payroll run not found");
    if (run.status !== "draft") {
      throw new BadRequestException(
        `Cannot add payslips to a run with status "${run.status}". Revert to draft first.`,
      );
    }

    const sumValues = (m: Record<string, number> | undefined): number => {
      if (!m) return 0;
      let total = 0;
      for (const v of Object.values(m)) {
        if (typeof v === "number" && Number.isFinite(v)) total += v;
      }
      return total;
    };

    const allowanceSum = sumValues(input.allowances ?? undefined);
    const deductionSum = sumValues(input.deductions ?? undefined);
    const grossPay =
      input.grossPay !== undefined
        ? input.grossPay
        : input.baseSalary + allowanceSum;
    const netPay =
      input.netPay !== undefined ? input.netPay : grossPay - deductionSum;

    const created = await repo.createPayslip(db, {
      payrollRunId: runId,
      employeeId: input.employeeId,
      baseSalary: input.baseSalary,
      allowances: input.allowances ?? null,
      deductions: input.deductions ?? null,
      currency: input.currency,
      grossPay,
      netPay,
    });

    const totals = await repo.sumPayslipTotalsForRun(db, runId);
    await repo.setRunTotals(db, runId, totals);

    return created;
  }

export async function updatePayslip(db: Db, 
    runId: string,
    payslipId: string,
    input: UpdatePayslipInput,
  ) {
    const existing = await repo.findPayslipById(db, payslipId);
    if (!existing) throw new NotFoundException("Payslip not found");
    if (existing.payrollRunId !== runId) {
      throw new BadRequestException("Payslip does not belong to this run");
    }

    const run = await repo.findRunById(db, runId);
    if (!run) throw new NotFoundException("Payroll run not found");
    if (run.status !== "draft") {
      throw new BadRequestException(
        `Cannot edit payslips on a run with status "${run.status}". Revert to draft first.`,
      );
    }

    // baseSalary/grossPay/netPay are Decimal columns over the wire; coerce
    // to plain numbers so the arithmetic below behaves.
    const baseSalary =
      input.baseSalary ?? Number(existing.baseSalary as unknown as string);
    const allowances =
      input.allowances === undefined
        ? (existing.allowances as Record<string, number> | null)
        : input.allowances;
    const deductions =
      input.deductions === undefined
        ? (existing.deductions as Record<string, number> | null)
        : input.deductions;
    const currency = input.currency ?? existing.currency;

    const sumValues = (m: Record<string, number> | null): number => {
      if (!m) return 0;
      let total = 0;
      for (const v of Object.values(m)) {
        if (typeof v === "number" && Number.isFinite(v)) total += v;
      }
      return total;
    };

    const allowanceSum = sumValues(allowances ?? null);
    const deductionSum = sumValues(deductions ?? null);
    const grossPay =
      input.grossPay !== undefined ? input.grossPay : baseSalary + allowanceSum;
    const netPay =
      input.netPay !== undefined ? input.netPay : grossPay - deductionSum;

    const updated = await repo.updatePayslip(db, payslipId, {
      baseSalary,
      allowances:
        allowances === null
          ? undefined
          : (allowances),
      deductions:
        deductions === null
          ? undefined
          : (deductions),
      currency,
      grossPay,
      netPay,
      // Pass-through documentUrl so HR can attach / clear the PDF via
      // the same edit path. `null` clears the field; `undefined`
      // leaves it untouched.
      ...(input.documentUrl !== undefined && {
        documentUrl: input.documentUrl,
      }),
    });

    const totals = await repo.sumPayslipTotalsForRun(db, runId);
    await repo.setRunTotals(db, runId, totals);

    return updated;
  }

export async function listConsultantInvoices(db: Db, 
    query: ConsultantInvoiceQuery,
    actorId: string,
    actorPermissions: string[],
  ) {
    const { page, limit, ...filters } = query;
    // Mirror the payslip ownership rule: payroll managers see every
    // invoice; a plain `payroll:read` consultant only sees their own.
    const canManage = isPayrollManager(actorPermissions);
    const scopedFilters = canManage
      ? filters
      : { ...filters, consultantIdScope: actorId };
    const { data, total } = await repo.findConsultantInvoices(db, 
      scopedFilters,
      page,
      limit,
    );

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

export async function createConsultantInvoice(db: Db, input: CreateConsultantInvoiceInput) {
    const whtAmount = (input.amount * input.whtRate) / 100;
    const netAmount = input.amount - whtAmount;

    return repo.createConsultantInvoice(db, {
      entityId: input.entityId,
      consultantId: input.consultantId,
      invoiceNo: input.invoiceNo,
      amount: input.amount,
      whtRate: input.whtRate,
      whtAmount,
      netAmount,
      period: input.period,
    });
  }

  // ── Per-run payslip bulk import ──────────────────────────────────────

  /**
   * Validate spreadsheet rows against an existing payroll run. Caller
   * supplies the runId; we resolve every employee, reject rows with bad
   * numbers, and reject rows that would duplicate an existing payslip
   * inside the same run (the schema has a unique constraint on
   * `(payrollRunId, employeeId)`).
   */
export async function previewPayslipImport(db: Db, 
    runId: string,
    rows: Array<Record<string, unknown>>,
  ) {
    const run = await repo.findRunById(db, runId);
    if (!run) throw new NotFoundException("Payroll run not found");

    // BD-feedback (Vivek, May 2026) — HR's template ships per-row
    // "Total Payout INR / USD / THB" columns where exactly one matches
    // the row's native currency and the entity-currency one holds the
    // pre-converted equivalent (FX baked in by HR's spreadsheet formulas).
    // We read that pre-converted value here so the run headline can sum
    // it directly instead of re-running FX through ExchangeRate.
    const entityCurrency = run.entity.currency;
    const baseColumnName = `Total Payout ${entityCurrency}`;

    const valid: Array<{
      rowNumber: number;
      employeeId: string;
      employeeName: string;
      baseSalary: number;
      allowances: number;
      deductions: number;
      tax: number;
      grossPay: number;
      netPay: number;
      grossPayBase: number | null;
      netPayBase: number | null;
      currency: string;
      breakdown: AllowanceDeductionBreakdown;
      // Snapshots — point-in-time copy of the HR spreadsheet cells.
      // Persisted on the payslip so the Run Details sheet doesn't have
      // to fall back to the live `users` row (which is empty for
      // contractor placeholders).
      position: string | null;
      department: string | null;
      startDate: string | null;
      /**
       * Populated when two or more spreadsheet rows for the same person
       * were folded into this entry. Contains every contributing row
       * number (including the primary) in upload order. The preview UI
       * surfaces this so HR can see which rows got merged.
       */
      mergedFromRows?: number[];
    }> = [];
    const errors: Array<{ row: number; message: string }> = [];
    const warnings: Array<{ row: number; message: string }> = [];

    const parsed: Array<{
      rowNumber: number;
      // Exactly one of these resolves the employee.
      employeeId?: string;
      employeeEmail?: string;
      employeeName?: string;
      baseSalary: number;
      allowances: number;
      deductions: number;
      tax: number;
      currency: string;
      breakdown: AllowanceDeductionBreakdown;
      /**
       * Verbatim "Total Payout {entityCurrency}" cell when the row supplied
       * one. We keep it raw here so the merge / native-vs-base resolution
       * below stays predictable; conversion to per-payslip `netPayBase` +
       * `grossPayBase` happens after merge.
       */
      totalPayoutBase: number | null;
      position: string | null;
      department: string | null;
      startDate: string | null;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 1;
      const row = rows[i]!;

      const employeeId = pickString(
        row,
        "employeeId",
        "employee_id",
        "Employee ID",
        "Employee Id",
      );
      const employeeEmail = pickString(
        row,
        "employeeEmail",
        "Email",
        "email",
      ).toLowerCase();
      const employeeName = pickString(
        row,
        "employeeName",
        "Employee Name",
        "Name",
        "name",
      );
      if (!employeeId && !employeeEmail && !employeeName) {
        errors.push({
          row: rowNumber,
          message: "Missing employee — provide ID, email, or full name",
        });
        continue;
      }

      const baseSalary = pickNumber(
        row,
        "Basic Salary",
        "basic_salary",
        "baseSalary",
        "base_salary",
        "Base Salary",
        "Salary (fiat)",
        "Salary",
        "salary",
      );
      if (!Number.isFinite(baseSalary) || baseSalary <= 0) {
        errors.push({
          row: rowNumber,
          message: "Missing or invalid base salary",
        });
        continue;
      }

      // Template-column allowances. HR template (May-2026 rev) ships
      // separate columns under a grouped Allowances header:
      //   Meal Allowance / Transportation Allowance / Phone Allowance /
      //   House Allowance, plus a top-level Internet Bills column.
      // Older sheets still using Meal / Transportation / Telephone /
      // Wifi (India Team) keep working via the alias list.
      const meal = pickNumber(row, "Meal Allowance", "Meal", "meal");
      const transportation = pickNumber(
        row,
        "Transportation Allowance",
        "Transportation",
        "transportation",
        "Transport",
      );
      const telephone = pickNumber(
        row,
        "Phone Allowance",
        "Telephone",
        "telephone",
        "Phone",
      );
      const house = pickNumber(row, "House Allowance", "house", "House");
      const internet = pickNumber(
        row,
        "Internet Bills",
        "Wifi (India Team)",
        "Wifi",
        "wifi",
        "Internet",
      );
      const overtime = pickNumber(row, "Overtime", "overtime", "OT");
      const otherIncome = pickNumber(
        row,
        "Other income",
        "Other Income",
        "other income",
        "Others income",
      );
      const reimbursement = pickNumber(row, "Reimbursement", "reimbursement");
      const flatAllowance = pickNumber(
        row,
        "allowances",
        "Allowances",
        "allowance",
      );
      const allowanceTotal =
        meal +
        transportation +
        telephone +
        house +
        internet +
        overtime +
        otherIncome +
        reimbursement +
        flatAllowance;

      const tax = pickNumber(row, "tax", "Tax");
      const ssf = pickNumber(row, "ssf", "SSF");
      const otherDeduction = pickNumber(
        row,
        "Other Deduction",
        "otherDeduction",
        "other_deduction",
      );
      const flatDeduction = pickNumber(
        row,
        "deductions",
        "Deductions",
        "deduction",
      );
      const deductionTotal = ssf + otherDeduction + flatDeduction;

      if (
        [
          meal,
          transportation,
          telephone,
          house,
          internet,
          overtime,
          otherIncome,
          reimbursement,
          flatAllowance,
          tax,
          ssf,
          otherDeduction,
          flatDeduction,
        ].some((n) => !Number.isFinite(n) || n < 0)
      ) {
        errors.push({
          row: rowNumber,
          message: "Allowance / deduction / tax cells must be non-negative",
        });
        continue;
      }

      const currencyRaw = pickString(row, "currency", "Currency").toUpperCase();
      const currency = currencyRaw.length === 3 ? currencyRaw : "THB";

      // HR template stores the row's net-payout-in-entity-currency under a
      // header that depends on the run's entity (e.g. "Total Payout THB"
      // for the Thailand entity). Read just that one cell — the other currency
      // columns are informational only and never feed the headline.
      const totalPayoutBaseRaw = pickNumber(
        row,
        baseColumnName,
        baseColumnName.toLowerCase(),
      );
      const totalPayoutBase =
        Number.isFinite(totalPayoutBaseRaw) && totalPayoutBaseRaw > 0
          ? totalPayoutBaseRaw
          : null;

      // Snapshot fields — verbatim cells from the HR template. Stored
      // as null when blank so the Run Details sheet can fall back to
      // the live `users` row instead of rendering an empty box.
      // Aliases cover both the old (Position / Start Date) and the
      // May-2026 (Designation / Date of Joining) header revisions.
      const position = pickString(
        row,
        "Designation",
        "designation",
        "Position",
        "position",
      );
      const department = pickString(row, "Department", "department");
      const startDate = pickString(
        row,
        "Date of Joining",
        "date of joining",
        "Start Date",
        "startDate",
        "start_date",
      );

      parsed.push({
        rowNumber,
        employeeId: employeeId || undefined,
        employeeEmail: employeeEmail || undefined,
        employeeName: employeeName || undefined,
        totalPayoutBase,
        baseSalary,
        allowances: allowanceTotal,
        deductions: deductionTotal,
        tax,
        currency,
        breakdown: {
          meal,
          transportation,
          telephone,
          house,
          internet,
          overtime,
          // `wifi` retained for compatibility with old payslips that
          // already serialised under this key. New imports populate
          // `internet` and leave `wifi` at 0 — the generator reads
          // whichever has a value (max), so historic rows still print.
          wifi: 0,
          otherIncome,
          reimbursement,
          flatAllowance,
          tax,
          ssf,
          otherDeduction,
          flatDeduction,
        },
        position: position || null,
        department: department || null,
        startDate: startDate || null,
      });
    }

    if (parsed.length > 0) {
      const ids = Array.from(
        new Set(parsed.map((p) => p.employeeId).filter(Boolean) as string[]),
      );
      const emails = Array.from(
        new Set(parsed.map((p) => p.employeeEmail).filter(Boolean) as string[]),
      );
      const needsNameLookup = parsed.some(
        (p) => !p.employeeId && !p.employeeEmail && p.employeeName,
      );

      const [byId, byEmail, allActive] = await Promise.all([
        repo.findUsersByIds(db, ids),
        repo.findUsersByEmails(db, emails),
        needsNameLookup
          ? repo.findUsersForBulkMatch(db, )
          : Promise.resolve(
              [] as Array<{ id: string; name: string; email: string }>,
            ),
      ]);
      const userById = new Map(byId.map((u) => [u.id, u] as const));
      const userByEmail = new Map(
        byEmail.map((u) => [u.email.toLowerCase(), u] as const),
      );
      const userByNormalisedName = new Map(
        allActive.map((u) => [normaliseName(u.name), u] as const),
      );
      // Bucket users by sorted-token-set so "Tran Van Hai" and "Hai
      // Tran Van" both map to the same key. Only used as a fallback
      // when there is exactly one candidate — ambiguous keys fall
      // through to the unresolved-row error path.
      const userByTokenSet = new Map<
        string,
        Array<{ id: string; name: string; email: string }>
      >();
      for (const u of allActive) {
        const key = tokenSetKey(u.name);
        const bucket = userByTokenSet.get(key) ?? [];
        bucket.push(u);
        userByTokenSet.set(key, bucket);
      }

      // Resolve every row to an employeeId, collecting unresolved as errors.
      const resolved: Array<{
        rowNumber: number;
        employeeId: string;
        employeeName: string;
      }> = [];
      const resolvedRows: typeof parsed = [];
      for (const p of parsed) {
        const user = matchImportRowToUser(
          p,
          userById,
          userByEmail,
          userByNormalisedName,
          userByTokenSet,
        );
        if (!user) {
          errors.push({
            row: p.rowNumber,
            message: `Could not match employee — ${
              p.employeeId
                ? `id ${p.employeeId}`
                : p.employeeEmail || p.employeeName || "(blank)"
            }`,
          });
          continue;
        }
        resolved.push({
          rowNumber: p.rowNumber,
          employeeId: user.id,
          employeeName: user.name,
        });
        resolvedRows.push({ ...p, employeeId: user.id });
      }

      // NOTE: We deliberately do NOT error on "this employee already
      // has a payslip in this run". The bulk-import commit is a replace
      // operation — it deletes every existing payslip on the run and
      // re-inserts what's in the spreadsheet — so a pre-existing
      // payslip is fine.
      //
      // Two rows for the same person inside the SAME upload behave like
      // this:
      //   - Same currency → folded into one payslip (HR's spreadsheets
      //     sometimes split one person across rows for base + retro top-up).
      //     baseSalary / allowances / deductions / tax and every breakdown
      //     bucket are summed; a warning is emitted on the secondary rows.
      //   - Different currency → kept as SEPARATE payslips. HR pays a few
      //     contractors a THB retainer plus a USD performance fee in the
      //     same period and the xlsx lists each currency on its own row;
      //     the schema's `@@unique([run, employee, currency])` lets both
      //     land. Merging across currencies would mix units (50k THB +
      //     7k USD ≠ 57k of anything) and was the source of the by-currency
      //     rollup corruption we hit on the Jan-2026 Thailand-entity run.
      const indexByEmployeeCurrency = new Map<string, number>();
      const employeeCurrencyKey = (employeeId: string, currency: string) =>
        `${employeeId}|${currency}`;

      for (let i = 0; i < resolvedRows.length; i++) {
        const p = resolvedRows[i]!;
        const r = resolved[i]!;
        const key = employeeCurrencyKey(p.employeeId!, p.currency);
        const existingIndex = indexByEmployeeCurrency.get(key);
        if (existingIndex !== undefined) {
          const existing = valid[existingIndex]!;
          existing.baseSalary += p.baseSalary;
          existing.allowances += p.allowances;
          existing.deductions += p.deductions;
          existing.tax += p.tax;
          for (const k of Object.keys(
            existing.breakdown,
          ) as (keyof AllowanceDeductionBreakdown)[]) {
            existing.breakdown[k] += p.breakdown[k] ?? 0;
          }
          existing.grossPay = existing.baseSalary + existing.allowances;
          existing.netPay =
            existing.grossPay - existing.deductions - existing.tax;
          // Roll up the per-row base-currency cells when both halves of the
          // merged pair supplied one. If either side is null we drop the
          // base columns rather than carry a half-computed value into the
          // headline.
          if (existing.netPayBase != null && p.totalPayoutBase != null) {
            existing.netPayBase += p.totalPayoutBase;
          } else {
            existing.netPayBase = null;
          }
          if (existing.grossPayBase != null && p.totalPayoutBase != null) {
            const impliedRate =
              p.baseSalary + p.allowances - p.deductions - p.tax > 0
                ? p.totalPayoutBase /
                  (p.baseSalary + p.allowances - p.deductions - p.tax)
                : 0;
            existing.grossPayBase +=
              (p.baseSalary + p.allowances) * impliedRate;
          } else {
            existing.grossPayBase = null;
          }
          existing.mergedFromRows = [
            ...(existing.mergedFromRows ?? [existing.rowNumber]),
            p.rowNumber,
          ];
          warnings.push({
            row: p.rowNumber,
            message: `Merged with row ${existing.rowNumber} for ${r.employeeName} (${p.currency}) — values summed.`,
          });
          if (existing.netPay < 0) {
            errors.push({
              row: existing.rowNumber,
              message:
                "Merged net pay is negative — review the duplicate rows for this employee.",
            });
          }
          continue;
        }

        const grossPay = p.baseSalary + p.allowances;
        const netPay = grossPay - p.deductions - p.tax;
        if (netPay < 0) {
          errors.push({
            row: p.rowNumber,
            message:
              "Net pay would be negative — fix base / allowances / deductions / tax",
          });
          continue;
        }
        // Resolve the row's base-currency equivalents. For rows already
        // priced in the entity currency we just mirror the native values
        // — no FX needed. Otherwise we trust HR's pre-converted cell when
        // present and back out the implied per-row rate to convert gross
        // (the template only ships a net-payout column, not gross).
        let netPayBase: number | null = null;
        let grossPayBase: number | null = null;
        if (p.currency === entityCurrency) {
          netPayBase = netPay;
          grossPayBase = grossPay;
        } else if (p.totalPayoutBase != null && netPay > 0) {
          netPayBase = p.totalPayoutBase;
          const impliedRate = p.totalPayoutBase / netPay;
          grossPayBase = grossPay * impliedRate;
        }
        valid.push({
          rowNumber: p.rowNumber,
          employeeId: p.employeeId!,
          employeeName: r.employeeName,
          baseSalary: p.baseSalary,
          allowances: p.allowances,
          deductions: p.deductions,
          tax: p.tax,
          grossPay,
          netPay,
          grossPayBase,
          netPayBase,
          currency: p.currency,
          breakdown: { ...p.breakdown },
          position: p.position,
          department: p.department,
          startDate: p.startDate,
        });
        indexByEmployeeCurrency.set(key, valid.length - 1);
      }
    }

    return {
      valid,
      errors,
      warnings,
      totalRows: rows.length,
      validCount: valid.length,
      errorCount: errors.length,
      warningCount: warnings.length,
    };
  }

export async function commitPayslipImport(db: Db, 
    runId: string,
    rows: Array<Record<string, unknown>>,
  ) {
    const run = await repo.findRunById(db, runId);
    if (!run) throw new NotFoundException("Payroll run not found");
    if (run.status !== "draft") {
      throw new BadRequestException(
        `Cannot import payslips into a run with status "${run.status}"`,
      );
    }

    const preview = await previewPayslipImport(db, runId, rows);
    if (preview.errorCount > 0) {
      throw new BadRequestException(
        `${preview.errorCount} rows have errors. Fix them and try again.`,
      );
    }
    if (preview.validCount === 0) {
      return {
        imported: 0,
        totalGross: Number(run.totalGross),
        totalNet: Number(run.totalNet),
        totalTax: Number(run.totalTax),
      };
    }

    // Tax isn't a Payslip column — the schema folds it into the
    // `deductions` JSON. We fold it there for the per-employee row but
    // accumulate it separately so the parent run's `totalTax` stays
    // correct.
    const payslipRows = preview.valid.map((p: (typeof preview.valid)[number]) => {
      const b = p.breakdown;
      const allowanceItems: Record<string, number> = {};
      if (b.meal > 0) allowanceItems.meal = b.meal;
      if (b.transportation > 0) {
        allowanceItems.transportation = b.transportation;
      }
      if (b.telephone > 0) allowanceItems.telephone = b.telephone;
      if (b.wifi > 0) allowanceItems.wifi = b.wifi;
      if (b.otherIncome > 0) allowanceItems.otherIncome = b.otherIncome;
      if (b.reimbursement > 0) allowanceItems.reimbursement = b.reimbursement;
      if (b.flatAllowance > 0) allowanceItems.allowance = b.flatAllowance;

      const deductionItems: Record<string, number> = {};
      if (b.tax > 0) deductionItems.tax = b.tax;
      if (b.ssf > 0) deductionItems.ssf = b.ssf;
      if (b.otherDeduction > 0) {
        deductionItems.otherDeduction = b.otherDeduction;
      }
      if (b.flatDeduction > 0) deductionItems.deduction = b.flatDeduction;

      return {
        employeeId: p.employeeId,
        baseSalary: p.baseSalary,
        allowances:
          Object.keys(allowanceItems).length > 0
            ? { ...allowanceItems, total: p.allowances }
            : null,
        deductions:
          Object.keys(deductionItems).length > 0
            ? { ...deductionItems, total: p.deductions + p.tax }
            : null,
        grossPay: p.grossPay,
        netPay: p.netPay,
        grossPayBase: p.grossPayBase,
        netPayBase: p.netPayBase,
        tax: p.tax,
        currency: p.currency,
        positionSnapshot: p.position,
        departmentSnapshot: p.department,
        startDateSnapshot: p.startDate,
      };
    });

    // Replace-all semantics. The spreadsheet is the source of truth for
    // the run, so we wipe any prior payslips (whether seeded by
    // createRun or carried over from a previous import attempt) and
    // re-insert the canonical set. Lets HR re-upload a corrected file
    // without hitting the @@unique([payrollRunId, employeeId]) constraint.
    //
    // Bucket totals by currency: a Thailand-entity run that pays a USD
    // contractor + an INR contractor used to sum 100,000 THB + 8,000
    // USD + 40,000 INR into a single `totalNet` cell. Now we split:
    // `currencyTotals` keeps the full per-currency rollup, and the
    // legacy headline columns (totalGross / totalTax / totalNet) only
    // sum the rows whose currency matches the run's entity currency —
    // which is what HR was eyeballing anyway.
    const currencyTotals: Record<
      string,
      { gross: number; tax: number; net: number; count: number }
    > = {};
    for (const p of preview.valid) {
      const bucket = (currencyTotals[p.currency] ??= {
        gross: 0,
        tax: 0,
        net: 0,
        count: 0,
      });
      bucket.gross += p.grossPay;
      bucket.tax += p.tax;
      bucket.net += p.netPay;
      bucket.count += 1;
    }

    // Write the payslips first; then re-aggregate via the FX-aware
    // recalc so the headline Total Gross / Total Tax / Total Net are
    // expressed in the entity currency across ALL payslips, not just
    // the entity-currency ones. We can't FX-convert inside the same
    // transaction as the inserts because the recalc has to read the
    // freshly persisted rows.
    await repo.runPayslipImportTransaction(db, runId, payslipRows);
    const recalc = await repo.sumPayslipTotalsForRun(db, runId);
    await repo.setRunTotals(db, runId, recalc);

    return {
      imported: preview.validCount,
      totalGross: recalc.totalGross,
      totalNet: recalc.totalNet,
      totalTax: recalc.totalTax,
      currencyTotals: recalc.currencyTotals,
      missingFxFor: recalc.missingFxFor,
    };
  }

  /**
   * Bulk-import entrypoint — the dialog has parsed the spreadsheet but
   * does NOT know which entity the rows belong to. We resolve as many
   * rows as we can (id / email / name / token-set), pick the dominant
   * `entityId` from the matched users, and either reuse the existing
   * draft run for (entity, period) or create an empty one. The dialog
   * then proceeds to the payslip preview/commit step against the
   * returned runId.
   *
   * Period is canonical YYYY-MM on the wire. The UI surfaces MM-YYYY,
   * the validation enforces YYYY-MM here so downstream code (totals
   * queries, reports, the existing unique index) stays consistent.
   */
export async function prepareRunFromImport(db: Db, input: PrepareImportRunInput, userId: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) {
      throw new BadRequestException("Period must be YYYY-MM");
    }
    if (input.identifiers.length === 0) {
      throw new BadRequestException(
        "Spreadsheet has no rows — upload a file with at least one employee",
      );
    }

    const allActive = await repo.findUsersForImportMatch(db, );
    const userByEmail = new Map(
      allActive.map((u) => [u.email.toLowerCase(), u] as const),
    );
    const userByNormalisedName = new Map(
      allActive.map((u) => [normaliseName(u.name), u] as const),
    );
    const userByTokenSet = new Map<string, Array<(typeof allActive)[number]>>();
    for (const u of allActive) {
      const key = tokenSetKey(u.name);
      const bucket = userByTokenSet.get(key) ?? [];
      bucket.push(u);
      userByTokenSet.set(key, bucket);
    }
    const userById = new Map<string, (typeof allActive)[number]>();

    // Tally entityId across matched rows. Whichever entity owns the
    // majority wins — gives HR room to make spelling typos in a row or
    // two without flipping the run onto a different entity.
    const entityTally = new Map<string, number>();
    let matched = 0;
    for (const r of input.identifiers) {
      const user = matchImportRowToUser(
        { employeeEmail: r.email, employeeName: r.name },
        userById,
        userByEmail,
        userByNormalisedName,
        userByTokenSet,
      );
      if (!user) continue;
      matched += 1;
      if (user.entityId) {
        entityTally.set(
          user.entityId,
          (entityTally.get(user.entityId) ?? 0) + 1,
        );
      }
    }

    if (entityTally.size === 0) {
      throw new BadRequestException(
        "Could not match any employee in the spreadsheet to an entity — check the Employee Name / Email columns",
      );
    }

    const [topEntityId] = [...entityTally.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0]!;

    const existing = await repo.findExistingRun(db, 
      topEntityId,
      input.period,
    );
    if (existing && existing.status !== "draft") {
      throw new ConflictException(
        `Payroll run for this entity and period is already ${existing.status} — create a new period or revert the run first`,
      );
    }

    const entityCodeRow = await repo.findEntityById(db, topEntityId);

    let runId: string;
    if (existing) {
      runId = existing.id;
    } else {
      const created = await repo.createEmptyRun(db, {
        entityId: topEntityId,
        period: input.period,
        runBy: userId,
      });
      if (!created) {
        throw new BadRequestException("Failed to create payroll run");
      }
      runId = created.id;

    }

    return {
      runId,
      entityId: topEntityId,
      entityCode: entityCodeRow?.code ?? null,
      entityName: entityCodeRow?.name ?? null,
      period: input.period,
      matchedCount: matched,
      totalRows: input.identifiers.length,
      reused: !!existing,
    };
  }

export async function previewImport(db: Db, rows: Array<Record<string, unknown>>) {
    const valid: Array<Record<string, unknown>> = [];
    const errors: Array<{ row: number; message: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const email = String(row.email || row.Email || "").trim();
      const grossSalary = Number(
        row.grossSalary || row["Gross Salary"] || row.gross_salary || 0,
      );

      if (!email) {
        errors.push({ row: i + 1, message: "Missing email" });
        continue;
      }
      if (!grossSalary || grossSalary <= 0) {
        errors.push({ row: i + 1, message: "Invalid gross salary" });
        continue;
      }

      valid.push({ ...row, email, grossSalary, rowIndex: i + 1 });
    }

    return {
      valid,
      errors,
      totalRows: rows.length,
      validCount: valid.length,
      errorCount: errors.length,
    };
  }

export async function commitImport(db: Db, rows: Array<Record<string, unknown>>, createdBy: string) {
    const preview = await previewImport(db, rows);
    if (preview.errorCount > 0) {
      throw new BadRequestException(
        `${preview.errorCount} rows have errors. Fix them and try again.`,
      );
    }


    return {
      imported: preview.validCount,
      message: `${preview.validCount} payroll records staged for review`,
    };
  }

  // ─── Employee-facing payslips ─────────────────────────────

  /**
   * /my-portal "My Payslip" tab — every payslip across every run for
   * one employee. No permission gate beyond auth: the caller's own id
   * is the scope key.
   */
export async function listMyPayslips(db: Db, employeeId: string) {
    return repo.findPayslipsByEmployeeId(db, employeeId);
  }

  /**
   * HR-only diagnostic. Surfaces why a specific employee sees an
   * empty /my-portal "My Payslip" tab — typically because a stale
   * bulk import bound their Payslip rows to a different User.id
   * whose name token-set matches (e.g. "Sara Lopez" vs the real
   * "Sarah Smith"). Output lets HR pick the misbound row and
   * rebind it with a one-line SQL UPDATE.
   *
   * Returns:
   * - `target`: the user lookup result for `email` (id, name,
   *   isActive). `found: false` when no user matches.
   * - `ownPayslipCount`: how many Payslip rows currently point at
   *   the target user's id.
   * - `candidates`: every OTHER user whose name shares the same
   *   sorted-token-set as the target (so "Sarah Smith" matches
   *   "Smith Sarah" and "Sarah  Smith "), with their payslip
   *   counts. The misbound user typically shows up here with a
   *   non-zero count.
   */
export async function diagnoseEmployeePayslips(db: Db, email: string) {
    const normalisedEmail = email.trim().toLowerCase();
    if (!normalisedEmail) {
      throw new BadRequestException("Query param `email` is required");
    }
    const target = await repo.findUserByEmail(db, normalisedEmail);
    if (!target) {
      return { found: false as const, email: normalisedEmail };
    }
    const ownPayslipCount = await repo.countPayslipsByEmployee(db, target.id);
    const allUsers = await repo.findAllUsersForDiagnose(db);
    const targetTokens = tokenSetKey(target.name);
    const candidateUsers = allUsers.filter(
      (u) => u.id !== target.id && tokenSetKey(u.name) === targetTokens,
    );
    const candidates = await Promise.all(
      candidateUsers.map(async (u) => ({
        user: u,
        payslipCount: await repo.countPayslipsByEmployee(db, u.id),
      })),
    );
    return {
      found: true as const,
      target,
      ownPayslipCount,
      candidates,
    };
  }

  /**
   * Resolve a 5-minute signed URL for the caller's own payslip PDF.
   * Throws 404 when:
   *   • the payslip doesn't exist,
   *   • it isn't theirs (defence-in-depth — the route already filters
   *     to req.user!.id),
   *   • the row has no `documentUrl` attached yet.
   */
export async function getMyPayslipDownloadUrl(db: Db, employeeId: string, payslipId: string) {
    const slip = await repo.findPayslipById(db, payslipId);
    if (!slip || slip.employeeId !== employeeId) {
      throw new NotFoundException("Payslip not found");
    }
    if (!slip.documentUrl) {
      throw new NotFoundException("No payslip document attached yet");
    }
    return { url: `/api/payroll/my-payslips/${payslipId}/file` };
  }

  /**
   * HR upload path. Stores the PDF on the `documents` bucket (private)
   * and writes the public URL onto the Payslip row. The /my-portal
   * download endpoint mints a fresh signed URL on each request, so
   * the persisted URL is just an addressable handle (the bucket is
   * private; no public access).
   */
export async function attachPayslipDocument(
    db: Db,
    runId: string,
    payslipId: string,
    _actorId: string,
    file: {
      bytes: Uint8Array;
      originalName: string;
      mimeType: string;
      size: number;
    },
    storage: PayrollStorage,
  ) {
    const slip = await repo.findPayslipById(db, payslipId);
    if (!slip) throw new NotFoundException("Payslip not found");
    if (slip.payrollRunId !== runId) {
      throw new BadRequestException("Payslip does not belong to this run");
    }
    const safeName = file.originalName.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const key = `payroll/payslips/${payslipId}/${safeName}`;
    await storage.put(key, file.bytes, file.mimeType);
    const documentUrl = `${R2_PRIVATE_PREFIX}${key}`;
    return repo.updatePayslip(db, payslipId, { documentUrl });
  }

  /**
   * HR-facing flat list (HRMS → Payslip Management). Returns rows
   * across every employee + run with the filters applied. Permission
   * gating is route-level (`payroll:read`).
   */
export async function listPayslipsForHr(db: Db, query: HrPayslipQuery) {
    return repo.findPayslipsForHr(db, query);
  }

  /**
   * HRMS → Payslip Management "Export data" (Excel / CSV). One row per payslip
   * with the full breakdown, using the SAME leaf-column names the importer
   * reads (`previewPayslipImport`), so an export can be edited and re-imported.
   *
   * Fidelity note: the persisted `allowances` JSON only keeps meal /
   * transportation / telephone / wifi / otherIncome / reimbursement / flat
   * `allowance` as individual keys — House / Overtime / new-style Internet are
   * folded into the total, not stored per-column. To keep a re-import's gross
   * exact, the leftover (`gross − base − namedAllowances`) is written into the
   * flat "Allowances" column; House / Overtime therefore export as 0. The
   * `deductions` JSON keeps ssf / otherDeduction / flat `deduction` (tax is the
   * scalar `tax` column), so deductions round-trip 1:1.
   */
export async function exportPayslips(db: Db, 
    query: HrPayslipQuery,
    format: "xlsx" | "csv",
    now: Date = new Date(),
  ): Promise<{ buffer: Uint8Array; filename: string; contentType: string }> {
    const slips = await repo.findPayslipsForHr(db, query);

    const num = (v: unknown): number => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const mapNum = (map: unknown, key: string): number =>
      map && typeof map === "object" && !Array.isArray(map)
        ? num((map as Record<string, unknown>)[key])
        : 0;

    // Leaf columns mirror the import template; trailing columns are read-only
    // review context the importer ignores.
    const headers = [
      "Employee Name",
      "Employee ID",
      "Email",
      "Designation",
      "Department",
      "Date of Joining",
      "Basic Salary",
      "Currency",
      "Pay Period",
      "Overtime",
      "Meal Allowance",
      "Transportation Allowance",
      "Phone Allowance",
      "House Allowance",
      "Internet Bills",
      "Other income",
      "Reimbursement",
      "Allowances",
      "Tax",
      "SSF",
      "Other Deduction",
      "Deductions",
      "Gross Pay",
      "Net Pay",
      "Net Pay (base)",
      "Status",
      "PDF Attached",
    ];

    const rows: unknown[][] = slips.map((s) => {
      const base = num(s.baseSalary);
      const gross = num(s.grossPay);
      const net = num(s.netPay);
      const meal = mapNum(s.allowances, "meal");
      const transportation = mapNum(s.allowances, "transportation");
      const telephone = mapNum(s.allowances, "telephone");
      const internet = mapNum(s.allowances, "wifi"); // legacy internet key
      const otherIncome = mapNum(s.allowances, "otherIncome");
      const reimbursement = mapNum(s.allowances, "reimbursement");
      const namedAllowances =
        meal +
        transportation +
        telephone +
        internet +
        otherIncome +
        reimbursement;
      // Remainder absorbs House / Overtime / new-Internet / original flat.
      const flatAllowance = Math.max(0, gross - base - namedAllowances);
      // Tax isn't a Payslip column — it's folded into the deductions JSON.
      const tax = mapNum(s.deductions, "tax");
      const ssf = mapNum(s.deductions, "ssf");
      const otherDeduction = mapNum(s.deductions, "otherDeduction");
      const flatDeduction = mapNum(s.deductions, "deduction");
      return [
        s.employee?.name ?? "",
        s.employee?.id ?? "",
        s.employee?.email ?? "",
        s.positionSnapshot ?? "",
        s.departmentSnapshot ?? s.employee?.department ?? "",
        s.startDateSnapshot ?? "",
        base,
        s.currency ?? "",
        s.payrollRun?.period ?? "",
        0, // Overtime — folded into Allowances (not stored per-column)
        meal,
        transportation,
        telephone,
        0, // House Allowance — folded into Allowances
        internet,
        otherIncome,
        reimbursement,
        flatAllowance,
        tax,
        ssf,
        otherDeduction,
        flatDeduction,
        gross,
        net,
        s.netPayBase != null ? num(s.netPayBase) : "",
        s.payrollRun?.status ?? "",
        s.documentUrl ? "Yes" : "No",
      ];
    });

    const stamp = now.toISOString().slice(0, 10);
    const scope = query.period ?? "all";

    if (format === "csv") {
      return {
        buffer: new TextEncoder().encode(rowsToCsv(headers, rows)),
        filename: `payslips-${scope}-${stamp}.csv`,
        contentType: "text/csv; charset=utf-8",
      };
    }

    const xlsx = await import("xlsx");
    const ws = xlsx.utils.aoa_to_sheet([headers, ...rows]);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, "Payslips");
    const buffer = xlsx.write(wb, {
      type: "array",
      bookType: "xlsx",
    }) as Uint8Array;
    return {
      buffer,
      filename: `payslips-${scope}-${stamp}.xlsx`,
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }

  /**
   * HR-side signed-URL download. Mirrors `getMyPayslipDownloadUrl`
   * but without the employee-id ownership check — route gates on
   * `payroll:read`. 404 when the row has no PDF attached.
   */
export async function getPayslipDownloadUrlForHr(db: Db, payslipId: string) {
    const slip = await repo.findPayslipById(db, payslipId);
    if (!slip) throw new NotFoundException("Payslip not found");
    if (!slip.documentUrl) {
      throw new NotFoundException("No payslip document attached yet");
    }
    return { url: `/api/payroll/payslips/${payslipId}/file` };
  }

export async function removePayslipDocument(
    db: Db,
    runId: string,
    payslipId: string,
    storage?: PayrollStorage,
  ) {
    const slip = await repo.findPayslipById(db, payslipId);
    if (!slip) throw new NotFoundException("Payslip not found");
    if (slip.payrollRunId !== runId) {
      throw new BadRequestException("Payslip does not belong to this run");
    }
    if (storage && slip.documentUrl) {
      const key = parseR2PrivateKey(slip.documentUrl);
      if (key) await storage.delete(key).catch(() => undefined);
    }
    return repo.updatePayslip(db, payslipId, { documentUrl: null });
  }

  // ── Payslip document generation ───────────────────────────────

  /**
   * Employee-facing variant of `exportPayslipDocument`. Same renderer,
   * stricter gating: caller must own the payslip AND the run must be
   * approved or paid. Draft runs stay hidden because the numbers
   * aren't HR-blessed yet — letting employees pull a PDF/xlsx off a
   * draft would surface numbers that may still change.
   */
export async function exportMyPayslipDocument(
    db: Db,
    employeeId: string,
    payslipId: string,
    format: ExportFormat,
  ) {
    const row = await repo.findPayslipWithRunForExport(db, payslipId);
    if (!row || row.payslip.employeeId !== employeeId) {
      throw new NotFoundException("Payslip not found");
    }
    if (!["approved", "paid"].includes(row.payrollRun.status)) {
      throw new ForbiddenException(
        "This payslip is not yet released. Wait until HR approves the payroll run.",
      );
    }
    const input: PayslipExportInput = {
      payslip: row.payslip,
      entityName: row.payrollRun.entity.name,
      period: row.payrollRun.period,
      company: await getPayslipCompany(db),
    };
    const filenameSafe = (row.payslip.employee.name ?? "Unknown").replace(
      /[/\\:*?"<>|]/g,
      "_",
    );
    const filename = `${row.payrollRun.period}-${filenameSafe}.${format}`;
    const buffer =
      format === "xlsx"
        ? await buildPayslipWorkbookBuffer(input)
        : await buildPayslipPdfBuffer(input);
    // TODO: PDF encryption via @cantoo/pdf-lib (protectPayslip skipped on edge)
    return { buffer, filename, protected: false as const };
  }

  /**
   * Render a single payslip as either an Excel workbook or a PDF.
   * Mirrors the HR-supplied "Payslips Testing.xlsx" layout cell-for-cell
   * so finance can drop the generated file into the archival folder
   * alongside historical hand-uploaded payslips.
   */
export async function exportPayslipDocument(db: Db, payslipId: string, format: ExportFormat) {
    const row = await repo.findPayslipWithRunForExport(db, payslipId);
    if (!row) throw new NotFoundException("Payslip not found");
    const input: PayslipExportInput = {
      payslip: row.payslip,
      entityName: row.payrollRun.entity.name,
      period: row.payrollRun.period,
      company: await getPayslipCompany(db),
    };
    const filenameSafe = (row.payslip.employee.name ?? "Unknown").replace(
      /[/\\:*?"<>|]/g,
      "_",
    );
    const filename = `${row.payrollRun.period}-${filenameSafe}.${format}`;
    const buffer =
      format === "xlsx"
        ? await buildPayslipWorkbookBuffer(input)
        : await buildPayslipPdfBuffer(input);
    return { buffer, filename };
  }

  /**
   * Render every payslip in a payroll run as a single zip archive. HR
   * clicks "Generate all" to ship a month's worth of payslips at once.
   */
export async function exportRunPayslipsZip(db: Db, runId: string, format: ExportFormat) {
    const run = await repo.findRunById(db, runId);
    if (!run) throw new NotFoundException("Payroll run not found");
    const slips = await repo.findPayslipsForRunExport(db, runId);
    if (slips.length === 0) {
      throw new BadRequestException(
        "This payroll run has no payslips to export yet",
      );
    }
    const entityName = run.entity?.name ?? "";
    const company = await getPayslipCompany(db);
    const inputs: PayslipExportInput[] = slips.map((s) => ({
      payslip: s,
      entityName,
      period: run.period,
      company,
    }));
    const buffer = await buildBulkPayslipZip(inputs, format);
    const safeEntity = entityName.replace(/\s+/g, "_");
    const filename = `payslips-${run.period}-${safeEntity}.zip`;
    return { buffer, filename };
  }

  /**
   * HRMS Payslip Management bulk delete. Drops the selected rows and
   * sweeps any attached PDFs from the `documents` bucket. Storage
   * deletes are best-effort (deleteFile logs + swallows errors) so a
   * missing or already-removed object can't block the DB delete.
   */
export async function bulkDeletePayslips(db: Db, ids: string[], storage?: PayrollStorage) {
    if (ids.length === 0) {
      return { deletedCount: 0 };
    }
    const slips = await repo.findPayslipDocumentUrls(db, ids);
    const result = await repo.bulkDeletePayslips(db, ids);
    if (storage) {
      await Promise.all(
        slips
          .map((s) => parseR2PrivateKey(s.documentUrl))
          .filter((k): k is string => k !== null)
          .map((key) => storage.delete(key).catch(() => undefined)),
      );
    }
    return { deletedCount: result.count };
  }

export async function resolvePayslipDocumentStream(
  db: Db,
  payslipId: string,
  opts?: { employeeId?: string },
): Promise<{ key: string; filename: string }> {
  const slip = await repo.findPayslipById(db, payslipId);
  if (!slip) throw new NotFoundException("Payslip not found");
  if (opts?.employeeId && slip.employeeId !== opts.employeeId) {
    throw new NotFoundException("Payslip not found");
  }
  if (!slip.documentUrl) {
    throw new NotFoundException("No payslip document attached yet");
  }
  const key = parseR2PrivateKey(slip.documentUrl);
  if (!key) throw new NotFoundException("Payslip file is not available");
  const filename = key.split("/").pop() ?? `payslip-${payslipId}`;
  return { key, filename };
}
