import type { InputJsonValue, Prisma } from "@nexora/database";

import { prisma } from "@/infrastructure/database/prisma";
import { createExchangeRateService } from "@/modules/exchange-rates/exchange-rates.service";

const payslipIncludes = {
  employee: {
    select: {
      id: true,
      name: true,
      email: true,
      department: true,
      jobTitle: true,
      startDate: true,
    },
  },
} satisfies Prisma.PayslipInclude;

const runIncludes = {
  entity: { select: { id: true, name: true, currency: true } },
  runner: { select: { id: true, name: true, email: true } },
  approver: { select: { id: true, name: true, email: true } },
} satisfies Prisma.PayrollRunInclude;

const consultantInvoiceIncludes = {
  entity: { select: { id: true, name: true } },
  consultant: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ConsultantInvoiceInclude;

export class PayrollRepository {
  async findRuns(
    filters: {
      entityId?: string;
      status?: string;
      period?: string;
      /**
       * When set, scopes the result to runs that include a payslip for
       * this employee. Used to give plain `payroll:read` employees a
       * "my payslips" view without exposing the company-wide ledger.
       */
      employeeIdScope?: string;
    },
    page: number,
    limit: number,
  ) {
    const where: Prisma.PayrollRunWhereInput = {};
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.status) where.status = filters.status;
    if (filters.period) where.period = filters.period;
    if (filters.employeeIdScope) {
      where.payslips = { some: { employeeId: filters.employeeIdScope } };
    }

    const [data, total] = await Promise.all([
      prisma.payrollRun.findMany({
        where,
        include: runIncludes,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.payrollRun.count({ where }),
    ]);

    return { data, total };
  }

  async findRunById(id: string) {
    return prisma.payrollRun.findUnique({
      where: { id },
      include: {
        ...runIncludes,
        payslips: {
          include: payslipIncludes,
          orderBy: { employee: { name: "asc" } },
        },
      },
    });
  }

  async findExistingRun(entityId: string, period: string) {
    return prisma.payrollRun.findUnique({
      where: { entityId_period: { entityId, period } },
    });
  }

  async createRunWithPayslips(
    data: {
      entityId: string;
      period: string;
      runBy: string;
      notes?: string;
    },
    employees: Array<{
      employeeId: string;
      baseSalary: number;
      allowances: Record<string, number> | null;
      deductions: Record<string, number> | null;
      grossPay: number;
      netPay: number;
      currency: string;
    }>,
  ) {
    const totalGross = employees.reduce((sum, e) => sum + e.grossPay, 0);
    const totalNet = employees.reduce((sum, e) => sum + e.netPay, 0);
    const totalTax = totalGross - totalNet;

    return prisma.payrollRun.create({
      data: {
        entityId: data.entityId,
        period: data.period,
        runBy: data.runBy,
        notes: data.notes,
        totalGross,
        totalNet,
        totalTax,
        payslips: {
          createMany: {
            data: employees.map((e) => ({
              employeeId: e.employeeId,
              baseSalary: e.baseSalary,
              allowances: (e.allowances ?? undefined) as InputJsonValue,
              deductions: (e.deductions ?? undefined) as InputJsonValue,
              grossPay: e.grossPay,
              netPay: e.netPay,
              currency: e.currency,
            })),
          },
        },
      },
      include: {
        ...runIncludes,
        payslips: { include: payslipIncludes },
      },
    });
  }

  async approveRun(id: string, approvedBy: string) {
    return prisma.payrollRun.update({
      where: { id },
      data: { status: "approved", approvedBy, approvedAt: new Date() },
      include: runIncludes,
    });
  }

  async deleteRun(id: string) {
    // Payslip.payrollRunId has onDelete: Cascade, so the child rows go
    // with the parent — no explicit deleteMany needed.
    return prisma.payrollRun.delete({ where: { id } });
  }

  async findPayslipById(id: string) {
    return prisma.payslip.findUnique({
      where: { id },
      include: payslipIncludes,
    });
  }

  async updatePayslip(id: string, data: Prisma.PayslipUpdateInput) {
    return prisma.payslip.update({
      where: { id },
      data,
      include: payslipIncludes,
    });
  }

  /**
   * Fetch just the id + documentUrl for a set of payslips. Used by the
   * bulk-delete path so the service knows which storage files to sweep
   * after the rows are gone.
   */
  async findPayslipDocumentUrls(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.payslip.findMany({
      where: { id: { in: ids } },
      select: { id: true, documentUrl: true },
    });
  }

  /**
   * Bulk-delete payslip rows. Storage cleanup is the service's job —
   * the repository only owns the DB write. Returns Prisma's BatchPayload
   * so the caller can report `{ deletedCount }`.
   */
  async bulkDeletePayslips(ids: string[]) {
    if (ids.length === 0) return { count: 0 };
    return prisma.payslip.deleteMany({ where: { id: { in: ids } } });
  }

  /**
   * Per-currency rollup for the run + headline totals (Total Gross /
   * Total Tax / Total Net) expressed in the run's entity currency.
   *
   * Headline totals now convert each off-currency payslip through the
   * latest exchange rate so a Thailand-entity run that pays a USD
   * contractor + an INR contractor reports a real "Total Net (THB)"
   * — the previous version only summed THB-currency payslips, which
   * silently dropped 32 of 51 slips on the Jan-2026 run.
   *
   * `currencyTotals` keeps the native per-currency rollup unchanged so
   * the per-currency strip in the UI still reflects what each
   * contractor was paid in their own currency.
   *
   * `missingFxFor` lists currencies that had no `exchange_rates` row;
   * those slips contribute 0 to the headline. The caller / UI should
   * surface a warning so HR knows the headline is incomplete.
   */
  async sumPayslipTotalsForRun(runId: string) {
    const run = await prisma.payrollRun.findUnique({
      where: { id: runId },
      select: { entity: { select: { currency: true } } },
    });
    const headlineCurrency = run?.entity.currency ?? null;

    const rows = await prisma.payslip.findMany({
      where: { payrollRunId: runId },
      select: {
        grossPay: true,
        netPay: true,
        grossPayBase: true,
        netPayBase: true,
        currency: true,
      },
    });

    const currencyTotals: Record<
      string,
      { gross: number; tax: number; net: number; count: number }
    > = {};
    for (const r of rows) {
      const gross = Number(r.grossPay ?? 0);
      const net = Number(r.netPay ?? 0);
      const bucket = (currencyTotals[r.currency] ??= {
        gross: 0,
        tax: 0,
        net: 0,
        count: 0,
      });
      bucket.gross += gross;
      bucket.net += net;
      bucket.tax += gross - net;
      bucket.count += 1;
    }

    // Headline aggregation: prefer the per-row base amounts the importer
    // stored from HR's "Total Payout {entityCurrency}" column. Falling
    // back to ExchangeRate stays as the legacy path for rows that
    // pre-date the column (or for manual single-payslip writes that
    // never went through the bulk importer).
    let headlineGross = 0;
    let headlineNet = 0;
    const missingFxFor = new Set<string>();
    if (headlineCurrency) {
      const fx = createExchangeRateService();
      for (const r of rows) {
        const gross = Number(r.grossPay ?? 0);
        const net = Number(r.netPay ?? 0);
        if (r.netPayBase != null && r.grossPayBase != null) {
          headlineGross += Number(r.grossPayBase);
          headlineNet += Number(r.netPayBase);
          continue;
        }
        if (r.currency === headlineCurrency) {
          headlineGross += gross;
          headlineNet += net;
          continue;
        }
        const { rate, source } = await fx.resolveRate(
          r.currency,
          headlineCurrency,
        );
        if (source === "missing") {
          missingFxFor.add(r.currency);
          continue;
        }
        headlineGross += gross * rate;
        headlineNet += net * rate;
      }
    }

    return {
      totalGross: headlineGross,
      totalNet: headlineNet,
      totalTax: headlineGross - headlineNet,
      currencyTotals,
      missingFxFor: Array.from(missingFxFor).sort(),
    };
  }

  async setRunTotals(
    runId: string,
    totals: {
      totalGross: number;
      totalNet: number;
      totalTax: number;
      currencyTotals?: Record<
        string,
        { gross: number; tax: number; net: number; count: number }
      >;
    },
  ) {
    return prisma.payrollRun.update({
      where: { id: runId },
      data: {
        totalGross: totals.totalGross,
        totalNet: totals.totalNet,
        totalTax: totals.totalTax,
        ...(totals.currencyTotals !== undefined && {
          currencyTotals: totals.currencyTotals as unknown as InputJsonValue,
        }),
      },
    });
  }

  async findEmployeesByEntity(entityId: string, employeeId?: string) {
    const where: Prisma.UserWhereInput = {
      entityId,
      isActive: true,
      employmentType: "full_time",
    };
    if (employeeId) where.id = employeeId;

    return prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        salary: true,
        currency: true,
      },
    });
  }

  async findUsersByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true },
    });
  }

  async findUsersByEmails(emails: string[]) {
    if (emails.length === 0) return [];
    return prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true, name: true, email: true },
    });
  }

  /**
   * Case-insensitive lookup so "Kunanon Jarat" matches "kunanon jarat".
   * Resigned (`isActive = false`) employees are included so HR can still
   * import a final payslip for someone who left mid-period.
   */
  async findUsersForBulkMatch() {
    return prisma.user.findMany({
      select: { id: true, name: true, email: true },
    });
  }

  /**
   * Variant that also returns `entityId` — used by the import-prepare
   * endpoint to infer which entity the spreadsheet belongs to before a
   * run is created. Includes resigned users for the same reason as
   * `findUsersForBulkMatch`.
   */
  async findUsersForImportMatch() {
    return prisma.user.findMany({
      select: { id: true, name: true, email: true, entityId: true },
    });
  }

  /**
   * Create an empty draft run (no seeded payslips). Used by the
   * bulk-import wizard which fills payslips entirely from the HR
   * spreadsheet — pre-seeding the whole entity here would just collide
   * with every imported row.
   */
  async createEmptyRun(data: {
    entityId: string;
    period: string;
    runBy: string;
    notes?: string;
  }) {
    return prisma.payrollRun.create({
      data: {
        entityId: data.entityId,
        period: data.period,
        runBy: data.runBy,
        notes: data.notes,
        totalGross: 0,
        totalNet: 0,
        totalTax: 0,
      },
      include: {
        ...runIncludes,
        payslips: { include: payslipIncludes },
      },
    });
  }

  /**
   * Wipe every payslip on a run so the next import commit can re-insert
   * the canonical set from the spreadsheet. The commit transaction
   * combines this with `buildCreatePayslipsManyInput` so HR can re-upload
   * the same file as many times as they need.
   */
  buildDeleteAllPayslipsInput(
    payrollRunId: string,
  ): Prisma.PrismaPromise<Prisma.BatchPayload> {
    return prisma.payslip.deleteMany({ where: { payrollRunId } });
  }

  buildSetRunTotalsInput(
    runId: string,
    totals: { gross: number; net: number; tax: number },
    currencyTotals?: Record<
      string,
      { gross: number; tax: number; net: number; count: number }
    > | null,
  ): Prisma.PrismaPromise<unknown> {
    return prisma.payrollRun.update({
      where: { id: runId },
      data: {
        totalGross: totals.gross,
        totalNet: totals.net,
        totalTax: totals.tax,
        ...(currencyTotals !== undefined && {
          currencyTotals: (currencyTotals === null
            ? null
            : currencyTotals) as InputJsonValue | null,
        }),
      },
    });
  }

  async findExistingPayslipEmployeeIds(payrollRunId: string, ids: string[]) {
    if (ids.length === 0) return [];
    const existing = await prisma.payslip.findMany({
      where: { payrollRunId, employeeId: { in: ids } },
      select: { employeeId: true },
    });
    return existing.map((p) => p.employeeId);
  }

  buildCreatePayslipsManyInput(
    payrollRunId: string,
    rows: Array<{
      employeeId: string;
      baseSalary: number;
      allowances: Record<string, number> | null;
      deductions: Record<string, number> | null;
      grossPay: number;
      netPay: number;
      grossPayBase?: number | null;
      netPayBase?: number | null;
      tax: number;
      currency: string;
      positionSnapshot?: string | null;
      departmentSnapshot?: string | null;
      startDateSnapshot?: string | null;
    }>,
  ): Prisma.PrismaPromise<Prisma.BatchPayload> {
    return prisma.payslip.createMany({
      data: rows.map((row) => ({
        payrollRunId,
        employeeId: row.employeeId,
        baseSalary: row.baseSalary,
        allowances: (row.allowances ?? undefined) as InputJsonValue,
        deductions: (row.deductions ?? undefined) as InputJsonValue,
        grossPay: row.grossPay,
        netPay: row.netPay,
        grossPayBase: row.grossPayBase ?? null,
        netPayBase: row.netPayBase ?? null,
        currency: row.currency,
        positionSnapshot: row.positionSnapshot ?? null,
        departmentSnapshot: row.departmentSnapshot ?? null,
        startDateSnapshot: row.startDateSnapshot ?? null,
      })),
    });
  }

  buildIncrementRunTotalsInput(
    runId: string,
    totals: { gross: number; net: number; tax: number },
  ): Prisma.PrismaPromise<unknown> {
    return prisma.payrollRun.update({
      where: { id: runId },
      data: {
        totalGross: { increment: totals.gross },
        totalNet: { increment: totals.net },
        totalTax: { increment: totals.tax },
      },
    });
  }

  async runTransaction<T>(
    operations: Prisma.PrismaPromise<unknown>[],
  ): Promise<T> {
    return prisma.$transaction(operations) as Promise<T>;
  }

  async findConsultantInvoices(
    filters: {
      entityId?: string;
      status?: string;
      period?: string;
      /**
       * When set, scopes the result to invoices belonging to this
       * consultant. Mirrors the payslip ownership scoping so plain
       * `payroll:read` consultants only see their own invoices.
       */
      consultantIdScope?: string;
    },
    page: number,
    limit: number,
  ) {
    const where: Prisma.ConsultantInvoiceWhereInput = {};
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.status) where.status = filters.status;
    if (filters.period) where.period = filters.period;
    if (filters.consultantIdScope) {
      where.consultantId = filters.consultantIdScope;
    }

    const [data, total] = await Promise.all([
      prisma.consultantInvoice.findMany({
        where,
        include: consultantInvoiceIncludes,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.consultantInvoice.count({ where }),
    ]);

    return { data, total };
  }

  async createConsultantInvoice(data: {
    entityId: string;
    consultantId: string;
    invoiceNo: string;
    amount: number;
    whtRate: number;
    whtAmount: number;
    netAmount: number;
    period: string;
  }) {
    return prisma.consultantInvoice.create({
      data,
      include: consultantInvoiceIncludes,
    });
  }

  // Employee-facing list — every payslip across every run for one
  // person. Sorted by period DESC so the freshest payslip lands at the
  // top of /my-portal "My Payslip".
  async findPayslipsByEmployeeId(employeeId: string) {
    return prisma.payslip.findMany({
      where: { employeeId },
      include: {
        payrollRun: {
          select: {
            id: true,
            period: true,
            entity: { select: { id: true, name: true } },
            status: true,
          },
        },
      },
      orderBy: [{ payrollRun: { period: "desc" } }, { currency: "asc" }],
    });
  }

  // Single-row create for HR's "+ New payslip" form on the HRMS
  // Payslip Management tab. Mirrors the bulk-import shape but takes
  // one row at a time so the dialog can return the persisted slip
  // and the caller can patch the table row in place.
  async createPayslip(data: {
    payrollRunId: string;
    employeeId: string;
    baseSalary: number;
    allowances: Record<string, number> | null;
    deductions: Record<string, number> | null;
    currency: string;
    grossPay: number;
    netPay: number;
    positionSnapshot?: string | null;
    departmentSnapshot?: string | null;
    startDateSnapshot?: string | null;
  }) {
    return prisma.payslip.create({
      data: {
        payrollRunId: data.payrollRunId,
        employeeId: data.employeeId,
        baseSalary: data.baseSalary,
        allowances: (data.allowances ?? undefined) as InputJsonValue,
        deductions: (data.deductions ?? undefined) as InputJsonValue,
        grossPay: data.grossPay,
        netPay: data.netPay,
        currency: data.currency,
        positionSnapshot: data.positionSnapshot ?? null,
        departmentSnapshot: data.departmentSnapshot ?? null,
        startDateSnapshot: data.startDateSnapshot ?? null,
      },
      include: payslipIncludes,
    });
  }

  // HR-facing flat list. Lets the HRMS Payslip Management tab filter
  // across every employee / run / period without forcing the user to
  // open each run individually.
  async findPayslipsForHr(filters: {
    employeeId?: string;
    entityId?: string;
    period?: string;
    hasDocument?: boolean;
  }) {
    const where: Prisma.PayslipWhereInput = {};
    if (filters.employeeId) where.employeeId = filters.employeeId;

    const payrollRunFilter: Prisma.PayrollRunWhereInput = {};
    if (filters.period) payrollRunFilter.period = filters.period;
    if (filters.entityId) payrollRunFilter.entityId = filters.entityId;
    if (Object.keys(payrollRunFilter).length > 0) {
      where.payrollRun = payrollRunFilter;
    }

    if (filters.hasDocument === true) where.documentUrl = { not: null };
    if (filters.hasDocument === false) where.documentUrl = null;

    return prisma.payslip.findMany({
      where,
      include: {
        employee: {
          select: { id: true, name: true, email: true, department: true },
        },
        payrollRun: {
          select: {
            id: true,
            period: true,
            entity: { select: { id: true, name: true } },
            status: true,
          },
        },
      },
      orderBy: [
        { payrollRun: { period: "desc" } },
        { employee: { name: "asc" } },
      ],
    });
  }
}

export const payrollRepository = new PayrollRepository();
