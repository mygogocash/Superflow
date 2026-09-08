"use client";

import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";

import {
  deriveStage,
  DISPLAY_STAGES,
  type DisplayStage,
  fmtMoney,
  fmtUsers,
  industryColor,
  probColor,
  REGION_COLOR,
  STAGE_COLOR,
  type StageBucket,
  stageBucket,
} from "@/components/opportunities/sales-dashboard-utils";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useBusinessUnits } from "@/hooks/use-business-units";
import { ApiError } from "@/lib/api-client";
import { BUSINESS_UNIT_UNASSIGNED as UNASSIGNED_BU } from "@/services/crm-business-unit.service";
import {
  getSalesDashboard,
  type SalesDashboardRow,
} from "@/services/crm-opportunity.service";

const SalesDashboardMap = dynamic(
  () =>
    import("@/components/opportunities/sales-dashboard-map").then(
      (m) => m.SalesDashboardMap,
    ),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[360px] w-full" />,
  },
);

// Enriched row carries the derived lifecycle stage + bucket so every
// exhibit reads the same classification.
interface Row extends SalesDashboardRow {
  displayStage: DisplayStage;
  bucket: StageBucket;
}

type SortCol =
  | "name"
  | "country"
  | "region"
  | "industry"
  | "displayStage"
  | "probability"
  | "value"
  | "totalUsers"
  | "appUsers";

type Drill =
  | null
  | `bucket:${StageBucket}`
  | `stage:${string}`
  | `region:${string}`;

const TODAY = new Date();

function distinct(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v))).sort(
    (a, b) => a.localeCompare(b),
  );
}

function SectionCard({
  title,
  note,
  exhibit,
  children,
  className,
}: {
  title: string;
  note?: string;
  /** Small exhibit caption rendered at the top of the body. */
  exhibit?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card
      className={`
        gap-0 p-0
        ${className ?? ""}
      `}
    >
      <div
        className={`
          border-border flex items-center justify-between border-b px-5 py-3
        `}
      >
        <span
          className={`
            text-foreground text-[10px] font-bold tracking-[0.12em] uppercase
          `}
        >
          {title}
        </span>
        {note ? (
          <span
            className={`
              text-muted-foreground bg-muted rounded px-2 py-0.5 font-mono
              text-[10px]
            `}
          >
            {note}
          </span>
        ) : null}
      </div>
      <div className="p-5">
        {exhibit ? (
          <div
            className={`
              text-muted-foreground mb-3 text-[9px] font-semibold
              tracking-[0.1em] uppercase
            `}
          >
            {exhibit}
          </div>
        ) : null}
        {children}
      </div>
    </Card>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`
        border-border bg-background text-foreground h-8 rounded-md border px-2
        text-xs
      `}
    >
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function SalesDashboard() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  const [regionF, setRegionF] = useState("");
  const [countryF, setCountryF] = useState("");
  const [stageF, setStageF] = useState("");
  const [ownerF, setOwnerF] = useState("");
  const [industryF, setIndustryF] = useState("");
  const [engF, setEngF] = useState("");
  // "Who is taking care of it" slice. Client-side like every other
  // filter here — the whole row set arrives in one fetch.
  const [businessUnitF, setBusinessUnitF] = useState("");
  const [monthF, setMonthF] = useState("");
  const [search, setSearch] = useState("");

  const [drill, setDrill] = useState<Drill>(null);
  const [sortCol, setSortCol] = useState<SortCol>("displayStage");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await getSalesDashboard();
      setRows(
        res.data.map((r) => {
          const displayStage = deriveStage(r);
          return { ...r, displayStage, bucket: stageBucket(displayStage) };
        }),
      );
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Failed to load dashboard";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Filter options derived from the data.
  const { units: businessUnits } = useBusinessUnits();

  const opts = useMemo(
    () => ({
      regions: distinct(rows.map((r) => r.region)),
      countries: distinct(rows.map((r) => r.country)),
      owners: distinct(rows.map((r) => r.ownerName)),
      industries: distinct(rows.map((r) => r.industry)),
      months: distinct(
        rows.map((r) =>
          r.revenueLaunchDate ? r.revenueLaunchDate.slice(0, 7) : null,
        ),
      ),
    }),
    [rows],
  );

  // Base = filtered rows (drives every exhibit). Drilled = base + the
  // active drill predicate (drives the deal table only).
  const base = useMemo(
    () =>
      rows.filter(
        (r) =>
          (!regionF || r.region === regionF) &&
          (!countryF || r.country === countryF) &&
          (!stageF || r.displayStage === stageF) &&
          (!ownerF || r.ownerName === ownerF) &&
          (!industryF || r.industry === industryF) &&
          (!engF || r.engagementType === engF) &&
          (!businessUnitF ||
            (businessUnitF === UNASSIGNED_BU
              ? (r.businessUnits ?? []).length === 0
              : (r.businessUnits ?? []).includes(businessUnitF))) &&
          (!monthF ||
            (r.revenueLaunchDate && r.revenueLaunchDate.startsWith(monthF))),
      ),
    [
      rows,
      regionF,
      countryF,
      stageF,
      ownerF,
      industryF,
      engF,
      monthF,
      businessUnitF,
    ],
  );

  const drilled = useMemo(() => {
    if (!drill) return base;
    const [kind, key] = drill.split(":") as [string, string];
    if (kind === "bucket") return base.filter((r) => r.bucket === key);
    if (kind === "stage") return base.filter((r) => r.displayStage === key);
    if (kind === "region") return base.filter((r) => r.region === key);
    return base;
  }, [base, drill]);

  const q = search.trim().toLowerCase();
  const tableRows = useMemo(() => {
    const filtered = q
      ? drilled.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            (r.accountName ?? "").toLowerCase().includes(q) ||
            (r.country ?? "").toLowerCase().includes(q) ||
            (r.industry ?? "").toLowerCase().includes(q),
        )
      : drilled;
    const sorted = [...filtered].sort((a, b) => {
      let av: string | number = a[sortCol] ?? "";
      let bv: string | number = b[sortCol] ?? "";
      if (sortCol === "displayStage") {
        av = DISPLAY_STAGES.indexOf(a.displayStage);
        bv = DISPLAY_STAGES.indexOf(b.displayStage);
      }
      if (typeof av === "string" && typeof bv === "string") {
        return av.localeCompare(bv) * sortDir;
      }
      return (Number(av) - Number(bv)) * sortDir;
    });
    return sorted;
  }, [drilled, q, sortCol, sortDir]);

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortCol(col);
      setSortDir(1);
    }
  }

  function toggleDrill(next: Drill) {
    setDrill((cur) => (cur === next ? null : next));
  }

  // ── KPI tiles ──────────────────────────────────────────────────────
  const tiles = useMemo(() => {
    const build = (bucket: StageBucket) => {
      const items = base.filter((r) => r.bucket === bucket);
      // totalUsers / appUsers / country are ACCOUNT-level — dedupe by account
      // so an account with several deals in the bucket is counted (and its
      // users summed) exactly once. TCV stays per-deal (sum of all deal values).
      const byAccount = new Map<string, (typeof items)[number]>();
      for (const r of items) {
        const key = r.accountId ?? r.accountName ?? r.id;
        if (!byAccount.has(key)) byAccount.set(key, r);
      }
      const accountsRows = Array.from(byAccount.values());
      return {
        accounts: byAccount.size,
        countries: distinct(accountsRows.map((r) => r.country)),
        totalUsers: accountsRows.reduce((s, r) => s + (r.totalUsers ?? 0), 0),
        appUsers: accountsRows.reduce((s, r) => s + (r.appUsers ?? 0), 0),
        tcv: items.reduce((s, r) => s + r.value, 0),
      };
    };
    return {
      live: build("live"),
      going_live: build("going_live"),
      pipeline: build("pipeline"),
    };
  }, [base]);

  // ── Charts / tables ────────────────────────────────────────────────
  const stageData = useMemo(
    () =>
      DISPLAY_STAGES.map((s) => ({
        stage: s,
        count: base.filter((r) => r.displayStage === s).length,
      })).filter((d) => d.count > 0),
    [base],
  );

  const industryData = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of base) {
      const k = r.industry ?? "Unknown";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return Array.from(m.entries())
      .map(([industry, count]) => ({ industry, count }))
      .sort((a, b) => b.count - a.count);
  }, [base]);

  // TCV + deal count per business unit. A deal tagged with two units is
  // counted under BOTH, so these totals intentionally sum to more than the
  // deal count — the question is "how much does each unit look after", not
  // a partition of the pipeline.
  const businessUnitData = useMemo(() => {
    const m = new Map<string, { tcv: number; count: number }>();
    for (const r of base) {
      const codes = r.businessUnits?.length ? r.businessUnits : [UNASSIGNED_BU];
      for (const code of codes) {
        const cur = m.get(code) ?? { tcv: 0, count: 0 };
        cur.tcv += r.value;
        cur.count += 1;
        m.set(code, cur);
      }
    }
    return Array.from(m.entries())
      .map(([code, v]) => ({
        code,
        label:
          code === UNASSIGNED_BU
            ? "Unassigned"
            : (businessUnits.find((u) => u.code === code)?.label ?? code),
        ...v,
      }))
      .sort((a, b) => b.tcv - a.tcv);
  }, [base, businessUnits]);

  const regions = useMemo(() => distinct(base.map((r) => r.region)), [base]);

  const countryTcv = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of base) {
      if (r.value > 0 && r.country) {
        m.set(r.country, (m.get(r.country) ?? 0) + r.value);
      }
    }
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  }, [base]);

  const countryCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of base) {
      if (r.country) m.set(r.country, (m.get(r.country) ?? 0) + 1);
    }
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  }, [base]);

  const revenue = useMemo(() => {
    const sum = (arr: Row[]) => arr.reduce((s, r) => s + r.value, 0);
    const live = base.filter((r) => r.bucket === "live");
    const going = base.filter((r) => r.bucket === "going_live");
    const pipe = base.filter((r) => r.bucket === "pipeline");
    const liveTcv = sum(live);
    const goingTcv = sum(going);
    const pipeTcv = sum(pipe);
    const total = liveTcv + goingTcv + pipeTcv;
    const weighted = pipe.reduce(
      (s, r) => s + (r.value * r.probability) / 100,
      0,
    );
    return { liveTcv, goingTcv, pipeTcv, total, weighted };
  }, [base]);

  const launchMonths = useMemo(() => {
    const pipe = base.filter(
      (r) => r.bucket === "pipeline" && r.revenueLaunchDate,
    );
    const m = new Map<string, Row[]>();
    for (const r of pipe) {
      const key = (r.revenueLaunchDate ?? "").slice(0, 7);
      const arr = m.get(key) ?? [];
      if (!m.has(key)) m.set(key, arr);
      arr.push(r);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [base]);

  const mapDeals = useMemo(
    () =>
      base
        .filter((r) => r.country)
        .map((r) => ({
          country: r.country as string,
          stage: r.displayStage,
          value: r.value,
        })),
    [base],
  );

  if (loading) {
    return (
      <div
        className={`
          bg-surface border-border flex min-h-[300px] items-center
          justify-center rounded-lg border shadow-sm
        `}
      >
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  const monthLabel = (key: string) =>
    new Date(`${key}-01T00:00:00`).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });

  const drillLabel = drill
    ? drill.startsWith("bucket:")
      ? {
          live: "Live accounts",
          going_live: "Going Live accounts",
          pipeline: "Pipeline accounts",
          lost: "Closed Lost",
        }[drill.split(":")[1] as StageBucket]
      : `${drill.split(":")[0]}: ${drill.split(":")[1]}`
    : null;

  return (
    <div className="flex flex-col gap-5">
      {/* Report title bar — McKinsey-style exhibit header in Manut brand */}
      <div
        className={`
          border-foreground flex items-end justify-between border-b-2 pb-3
        `}
      >
        <div>
          <h2 className="text-foreground font-serif text-2xl leading-tight">
            Sales Pipeline Overview
          </h2>
          <p
            className={`
              text-muted-foreground mt-1 flex items-center gap-2 text-xs
            `}
          >
            Leads, accounts &amp; opportunities across all regions
            <span
              className={`
                bg-muted-foreground/50 inline-block size-1 rounded-full
              `}
            />
            {rows.length} opportunities
          </p>
        </div>
        <div className="text-right">
          <div
            className={`
              text-muted-foreground text-[9px] font-semibold tracking-[0.1em]
              uppercase
            `}
          >
            As of
          </div>
          <div className="text-muted-foreground font-mono text-[11px]">
            {TODAY.toLocaleDateString("en-GB", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </div>
        </div>
      </div>

      {/* Filters strip */}
      <div
        className={`
          border-border bg-surface flex flex-wrap items-center gap-2 rounded-md
          border px-3 py-2
        `}
      >
        <span
          className={`
            text-muted-foreground mr-1 text-[9px] font-bold tracking-[0.1em]
            uppercase
          `}
        >
          Filter by
        </span>
        <FilterSelect
          label="All regions"
          value={regionF}
          onChange={setRegionF}
          options={opts.regions.map((v) => ({ value: v, label: v }))}
        />
        <FilterSelect
          label="All countries"
          value={countryF}
          onChange={setCountryF}
          options={opts.countries.map((v) => ({ value: v, label: v }))}
        />
        <FilterSelect
          label="All stages"
          value={stageF}
          onChange={setStageF}
          options={DISPLAY_STAGES.map((v) => ({ value: v, label: v }))}
        />
        <FilterSelect
          label="All owners"
          value={ownerF}
          onChange={setOwnerF}
          options={opts.owners.map((v) => ({ value: v, label: v }))}
        />
        <FilterSelect
          label="All industries"
          value={industryF}
          onChange={setIndustryF}
          options={opts.industries.map((v) => ({ value: v, label: v }))}
        />
        <FilterSelect
          label="All business units"
          value={businessUnitF}
          onChange={setBusinessUnitF}
          options={[
            ...businessUnits.map((u) => ({ value: u.code, label: u.label })),
            { value: UNASSIGNED_BU, label: "Unassigned" },
          ]}
        />
        <FilterSelect
          label="All engagement"
          value={engF}
          onChange={setEngF}
          options={[
            { value: "revenue", label: "Revenue" },
            { value: "engagement", label: "Engagement" },
          ]}
        />
        <FilterSelect
          label="All launch months"
          value={monthF}
          onChange={setMonthF}
          options={opts.months.map((v) => ({ value: v, label: monthLabel(v) }))}
        />
        <span
          className={`
            text-muted-foreground bg-muted ml-auto rounded px-2 py-0.5 font-mono
            text-[11px]
          `}
        >
          Showing <b className="text-primary">{base.length}</b> / {rows.length}
        </span>
      </div>

      {drill ? (
        <div
          className={`
            border-border bg-accent/30 flex items-center justify-between
            rounded-md border px-3 py-2 text-xs
          `}
        >
          <span className="text-foreground">
            Filtered view: <b>{drillLabel}</b>
          </span>
          <button
            type="button"
            onClick={() => setDrill(null)}
            className={`
              text-primary
              hover:underline
            `}
          >
            ✕ Clear
          </button>
        </div>
      ) : null}

      {/* KPI tiles */}
      <div
        className={`
          grid grid-cols-1 gap-3
          md:grid-cols-3
        `}
      >
        {[
          {
            key: "live" as const,
            label: "Live accounts",
            color: STAGE_COLOR.Live,
          },
          {
            key: "going_live" as const,
            label: "Going Live",
            color: STAGE_COLOR["Going Live"],
          },
          {
            key: "pipeline" as const,
            label: "Sales pipeline",
            color: STAGE_COLOR.Qualified,
          },
        ].map(({ key, label, color }) => {
          const t = tiles[key];
          const active = drill === `bucket:${key}`;
          return (
            <Card
              key={key}
              onClick={() => toggleDrill(`bucket:${key}`)}
              className={`
                cursor-pointer gap-0 overflow-hidden p-0 transition
                hover:shadow-md
                ${active ? "ring-primary ring-2" : ""}
              `}
            >
              {/* Group header band */}
              <div
                className={`
                  flex items-center justify-between px-4 py-2 text-[10px]
                  font-bold tracking-[0.1em] uppercase
                `}
                style={{ background: `${color}1f`, color }}
              >
                <span>{label}</span>
                <span className="font-mono tracking-normal normal-case">
                  TCV {fmtMoney(t.tcv)}
                </span>
              </div>
              <div className="p-4">
                <div className="grid grid-cols-2 gap-y-3">
                  {[
                    { v: t.accounts, l: "Accounts" },
                    { v: t.countries.length, l: "Countries" },
                    { v: fmtUsers(t.totalUsers), l: "Total users" },
                    { v: fmtUsers(t.appUsers), l: "App users" },
                  ].map((s) => (
                    <div key={s.l}>
                      <div
                        className="font-serif text-2xl leading-none"
                        style={{ color }}
                      >
                        {s.v}
                      </div>
                      <div
                        className={`
                          text-muted-foreground mt-1 text-[9px] font-semibold
                          tracking-wide uppercase
                        `}
                      >
                        {s.l}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {t.countries.slice(0, 8).map((c) => (
                    <span
                      key={c}
                      className={`
                        bg-muted text-muted-foreground rounded px-1.5 py-0.5
                        text-[9px]
                      `}
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Charts grid */}
      <div
        className={`
          grid grid-cols-1 gap-4
          lg:grid-cols-2
        `}
      >
        <SectionCard
          title="Deals by stage"
          note={`${base.length} deals`}
          exhibit="Exhibit 1 — Pipeline stage distribution"
        >
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stageData}>
                <XAxis
                  dataKey="stage"
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                  interval={0}
                  angle={-20}
                  textAnchor="end"
                  height={50}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                />
                <Tooltip
                  cursor={{ fill: "hsl(var(--accent))", opacity: 0.3 }}
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                />
                <Bar
                  dataKey="count"
                  radius={[2, 2, 0, 0]}
                  onClick={(_, index) => {
                    const d = stageData[index];
                    if (d) toggleDrill(`stage:${d.stage}`);
                  }}
                  className="cursor-pointer"
                >
                  {stageData.map((d) => (
                    <Cell key={d.stage} fill={STAGE_COLOR[d.stage]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>

        <SectionCard
          title="Going live — launch calendar"
          note="pipeline · by rev. launch"
          exhibit="Exhibit 2 — Upcoming launches by month"
        >
          {launchMonths.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-xs">
              No pipeline accounts with a revenue launch date
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {launchMonths.map(([month, accounts]) => (
                <div key={month}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span
                      className={`
                        bg-primary/15 text-primary rounded px-2 py-0.5
                        text-[9px] font-bold tracking-wide uppercase
                      `}
                    >
                      {monthLabel(month)}
                    </span>
                    <span className="text-muted-foreground text-[11px]">
                      {accounts.length} account
                      {accounts.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  {accounts.map((r) => (
                    <div
                      key={r.id}
                      className={`
                        border-border/60 flex items-center justify-between
                        border-t py-1.5 text-xs
                      `}
                    >
                      <span className="text-foreground font-medium">
                        {r.name}
                      </span>
                      <span
                        className={`
                          text-muted-foreground flex gap-3 text-[11px]
                        `}
                      >
                        <span>{r.country ?? "—"}</span>
                        <span style={{ color: STAGE_COLOR["Going Live"] }}>
                          {r.revenueLaunchDate}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Region × stage matrix"
          note="deal count · click to drill"
          exhibit="Exhibit 3 — Cross-dimensional deal count"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-border border-b">
                  <th
                    className={`
                      text-muted-foreground py-2 text-left text-[9px] font-bold
                      tracking-wide uppercase
                    `}
                  >
                    Region
                  </th>
                  {DISPLAY_STAGES.map((s) => (
                    <th
                      key={s}
                      className={`
                        text-muted-foreground px-1 py-2 text-center text-[9px]
                        font-bold uppercase
                      `}
                    >
                      {s}
                    </th>
                  ))}
                  <th
                    className={`
                      text-muted-foreground px-1 py-2 text-center text-[9px]
                      font-bold uppercase
                    `}
                  >
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {regions.map((region) => {
                  const rd = base.filter((r) => r.region === region);
                  return (
                    <tr key={region} className="border-border/50 border-b">
                      <td
                        className={`
                          text-foreground cursor-pointer py-1.5 text-left
                          font-medium
                          hover:text-primary
                        `}
                        onClick={() => toggleDrill(`region:${region}`)}
                      >
                        {region}
                      </td>
                      {DISPLAY_STAGES.map((s) => {
                        const n = rd.filter((r) => r.displayStage === s).length;
                        return (
                          <td key={s} className="px-1 py-1.5 text-center">
                            {n ? (
                              <button
                                type="button"
                                onClick={() => toggleDrill(`stage:${s}`)}
                                className={`
                                  inline-flex min-w-6 items-center
                                  justify-center rounded px-1.5 py-0.5
                                  text-[11px] font-bold
                                `}
                                style={{
                                  background: `${STAGE_COLOR[s]}22`,
                                  color: STAGE_COLOR[s],
                                }}
                              >
                                {n}
                              </button>
                            ) : (
                              <span className="text-muted-foreground/40">
                                —
                              </span>
                            )}
                          </td>
                        );
                      })}
                      <td
                        className={`
                          text-foreground px-1 py-1.5 text-center font-mono
                          font-bold
                        `}
                      >
                        {rd.length}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>

        <SectionCard
          title="Industry mix"
          note={`${industryData.length} verticals`}
          exhibit="Exhibit 4 — Deal count by industry vertical"
        >
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={industryData}
                layout="vertical"
                margin={{ left: 20 }}
              >
                <XAxis
                  type="number"
                  allowDecimals={false}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                />
                <YAxis
                  type="category"
                  dataKey="industry"
                  width={90}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                />
                <Tooltip
                  cursor={{ fill: "hsl(var(--accent))", opacity: 0.3 }}
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="count" radius={[0, 2, 2, 0]}>
                  {industryData.map((d, i) => (
                    <Cell key={d.industry} fill={industryColor(i)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>

        <SectionCard
          title="TCV by country"
          note="top 10"
          exhibit="Exhibit 5 — Country TCV concentration"
        >
          <CountryBars
            rows={countryTcv.map(([c, v]) => ({
              label: c,
              value: v,
              display: fmtMoney(v),
              color: regionColorFor(base, c),
            }))}
          />
        </SectionCard>

        <SectionCard
          title="Deal count by country"
          note="all stages"
          exhibit="Exhibit 6 — Account concentration by geography"
        >
          <CountryBars
            rows={countryCount.map(([c, n]) => ({
              label: c,
              value: n,
              display: `${n} deal${n > 1 ? "s" : ""}`,
              color: regionColorFor(base, c),
            }))}
          />
        </SectionCard>

        <SectionCard
          title="Geographic footprint"
          note="colored by stage · hover for detail"
          exhibit="Exhibit 7 — Deal stage by country"
          className="lg:col-span-2"
        >
          <SalesDashboardMap deals={mapDeals} />
        </SectionCard>
      </div>

      {/* TCV revenue summary */}
      <SectionCard
        title="TCV revenue summary"
        note="contracted · live vs pipeline"
        exhibit="Exhibit 8 — Contracted vs pipeline value"
      >
        <div
          className={`
            grid grid-cols-2 gap-4
            md:grid-cols-4
          `}
        >
          {[
            {
              l: "Total contracted TCV",
              v: fmtMoney(revenue.total),
              c: "hsl(var(--foreground))",
              s: "Live + Going Live + Pipeline",
            },
            {
              l: "Live TCV",
              v: fmtMoney(revenue.liveTcv),
              c: STAGE_COLOR.Live,
              s: revenue.total
                ? `${Math.round((revenue.liveTcv / revenue.total) * 100)}% of total`
                : "—",
            },
            {
              l: "Going Live TCV",
              v: fmtMoney(revenue.goingTcv),
              c: STAGE_COLOR["Going Live"],
              s: revenue.total
                ? `${Math.round((revenue.goingTcv / revenue.total) * 100)}% of total`
                : "—",
            },
            {
              l: "Pipeline TCV",
              v: fmtMoney(revenue.pipeTcv),
              c: STAGE_COLOR.Qualified,
              s: `${fmtMoney(Math.round(revenue.weighted))} weighted`,
            },
          ].map((x) => (
            <div key={x.l}>
              <div
                className={`
                  text-muted-foreground text-[9px] font-semibold tracking-wide
                  uppercase
                `}
              >
                {x.l}
              </div>
              <div className="mt-1 font-serif text-2xl" style={{ color: x.c }}>
                {x.v}
              </div>
              <div className="text-muted-foreground mt-1 text-[11px]">
                {x.s}
              </div>
            </div>
          ))}
        </div>
        {revenue.total > 0 ? (
          <div className="mt-4 flex h-2.5 overflow-hidden rounded">
            {[
              { v: revenue.liveTcv, c: STAGE_COLOR.Live },
              { v: revenue.goingTcv, c: STAGE_COLOR["Going Live"] },
              { v: revenue.pipeTcv, c: STAGE_COLOR.Qualified },
            ].map((seg, i) => (
              <div
                key={i}
                style={{
                  width: `${(seg.v / revenue.total) * 100}%`,
                  background: seg.c,
                }}
              />
            ))}
          </div>
        ) : null}
      </SectionCard>

      {/* Business-unit ownership */}
      <SectionCard
        title="Business unit ownership"
        note={`${businessUnitData.length} units · a shared deal counts under each`}
        exhibit="Exhibit 9 — TCV and deal count by business unit"
      >
        {businessUnitData.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-xs">
            No deals in the current selection.
          </p>
        ) : (
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={businessUnitData}
                layout="vertical"
                margin={{ left: 20 }}
              >
                <XAxis
                  type="number"
                  tickFormatter={(v: number) => fmtMoney(v)}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={120}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                />
                <Tooltip
                  cursor={{ fill: "hsl(var(--accent))", opacity: 0.3 }}
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                  formatter={(v) => fmtMoney(Number(v))}
                />
                <Bar dataKey="tcv" radius={[0, 2, 2, 0]}>
                  {businessUnitData.map((d, i) => (
                    <Cell key={d.code} fill={industryColor(i)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </SectionCard>

      {/* Deal table */}
      <SectionCard
        title={drillLabel ?? "Account detail"}
        note={`${tableRows.length} records`}
      >
        <div className="mb-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search accounts…"
            className={`
              border-border bg-background text-foreground h-8 w-56 rounded-md
              border px-2.5 text-xs
            `}
          />
        </div>
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-background sticky top-0 z-10">
              <tr className="border-border border-b-2">
                {(
                  [
                    ["name", "Account"],
                    ["country", "Country"],
                    ["region", "Region"],
                    ["industry", "Industry"],
                    ["displayStage", "Stage"],
                    ["probability", "Prob."],
                    ["value", "TCV"],
                    ["totalUsers", "Total users"],
                    ["appUsers", "App users"],
                  ] as [SortCol, string][]
                ).map(([col, label]) => (
                  <th
                    key={col}
                    onClick={() => toggleSort(col)}
                    className={`
                      text-muted-foreground cursor-pointer py-2 pr-3 text-left
                      text-[9px] font-bold tracking-wide whitespace-nowrap
                      uppercase
                      hover:text-foreground
                    `}
                  >
                    {label}
                    {sortCol === col ? (sortDir === 1 ? " ↑" : " ↓") : ""}
                  </th>
                ))}
                <th
                  className={`
                    text-muted-foreground py-2 pr-3 text-left text-[9px]
                    font-bold tracking-wide uppercase
                  `}
                >
                  Launch
                </th>
                <th
                  className={`
                    text-muted-foreground py-2 pr-3 text-left text-[9px]
                    font-bold tracking-wide uppercase
                  `}
                >
                  Owner
                </th>
              </tr>
            </thead>
            <tbody>
              {tableRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={11}
                    className="text-muted-foreground py-8 text-center"
                  >
                    No accounts match the current selection
                  </td>
                </tr>
              ) : (
                tableRows.map((r) => (
                  <tr
                    key={r.id}
                    className={`
                      border-border/40 border-b
                      hover:bg-accent/30
                    `}
                  >
                    <td className="text-foreground py-2 pr-3 font-medium">
                      {r.name}
                    </td>
                    <td className="text-muted-foreground py-2 pr-3">
                      {r.country ?? "—"}
                    </td>
                    <td className="py-2 pr-3">
                      {r.region ? (
                        <span
                          className={`
                            rounded px-1.5 py-0.5 text-[10px] font-semibold
                          `}
                          style={{
                            background: `${REGION_COLOR[r.region] ?? "#64748b"}22`,
                            color: REGION_COLOR[r.region] ?? "#64748b",
                          }}
                        >
                          {r.region}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="text-muted-foreground py-2 pr-3">
                      {r.industry ?? "—"}
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className={`
                          rounded px-2 py-0.5 text-[10px] font-semibold
                          whitespace-nowrap
                        `}
                        style={{
                          background: `${STAGE_COLOR[r.displayStage]}22`,
                          color: STAGE_COLOR[r.displayStage],
                        }}
                      >
                        {r.displayStage}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className="font-mono text-[11px]"
                        style={{ color: probColor(r.probability) }}
                      >
                        {r.probability}%
                      </span>
                    </td>
                    <td
                      className={`
                        text-foreground py-2 pr-3 font-mono text-[11px]
                      `}
                    >
                      {r.value ? fmtMoney(r.value) : "—"}
                    </td>
                    <td
                      className={`
                        text-muted-foreground py-2 pr-3 font-mono text-[11px]
                      `}
                    >
                      {r.totalUsers ? `${fmtUsers(r.totalUsers)}` : "—"}
                    </td>
                    <td
                      className={`
                        text-muted-foreground py-2 pr-3 font-mono text-[11px]
                      `}
                    >
                      {r.appUsers ? `${fmtUsers(r.appUsers)}` : "—"}
                    </td>
                    <td
                      className={`
                        text-muted-foreground py-2 pr-3 font-mono text-[11px]
                      `}
                    >
                      {r.launchDate ?? "—"}
                    </td>
                    <td className="text-muted-foreground py-2 pr-3 text-[11px]">
                      {r.ownerName ?? "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

function regionColorFor(rows: Row[], country: string): string {
  const row = rows.find((r) => r.country === country);
  return (row?.region && REGION_COLOR[row.region]) || "#2563eb";
}

function CountryBars({
  rows,
}: {
  rows: { label: string; value: number; display: string; color: string }[];
}) {
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground py-6 text-center text-xs">No data</p>
    );
  }
  const max = rows[0]?.value || 1;
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <span className="text-foreground w-28 shrink-0 truncate text-xs">
            {r.label}
          </span>
          <div className="bg-muted h-1.5 flex-1 rounded">
            <div
              className="h-1.5 rounded"
              style={{
                width: `${Math.round((r.value / max) * 100)}%`,
                background: r.color,
              }}
            />
          </div>
          <span
            className={`
              text-muted-foreground w-16 shrink-0 text-right font-mono
              text-[11px]
            `}
          >
            {r.display}
          </span>
        </div>
      ))}
    </div>
  );
}
