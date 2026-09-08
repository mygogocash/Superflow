import { describe, expect, it } from "vitest";
import { dueJobs, localTime, tickKey, JOBS } from "../src/schedule";

const TZ = "Asia/Bangkok"; // UTC+7, no DST
const bkk = (h: number, m: number, day = 15) => new Date(Date.UTC(2026, 8, day, h - 7, m));

describe("localTime", () => {
  it("converts UTC instants to Bangkok wall clock", () => {
    expect(localTime(new Date("2026-09-15T01:00:00Z"), TZ)).toEqual({
      year: 2026,
      month: 9,
      day: 15,
      hour: 8,
      minute: 0,
    });
    expect(localTime(new Date("2026-09-14T17:30:00Z"), TZ)).toEqual({
      year: 2026,
      month: 9,
      day: 15,
      hour: 0,
      minute: 30,
    });
  });
});

describe("dueJobs", () => {
  it("fires the 08:00 daily jobs exactly once a day", () => {
    const names = dueJobs(bkk(8, 0), TZ).map((j) => j.name);
    expect(names).toEqual(expect.arrayContaining(["it-billing-reminders", "crm-deadline-reminders", "accounting-status"]));
    expect(dueJobs(bkk(8, 10), TZ).map((j) => j.name)).not.toContain("it-billing-reminders");
  });
  it("fires crm-email-sync on every 10-minute tick", () => {
    for (const m of [0, 10, 20, 30, 40, 50]) expect(dueJobs(bkk(13, m), TZ).map((j) => j.name)).toContain("crm-email-sync");
  });
  it("fires monthly job only on day 22 at 09:00", () => {
    expect(dueJobs(bkk(9, 0, 22), TZ).map((j) => j.name)).toContain("expense-monthly-reminders");
    expect(dueJobs(bkk(9, 0, 21), TZ).map((j) => j.name)).not.toContain("expense-monthly-reminders");
  });
  it("covers all 20 job names across a full day of ticks (monthly job on its day)", () => {
    const seen = new Set<string>();
    for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m += 10) for (const j of dueJobs(bkk(h, m, 22), TZ)) seen.add(j.name);
    expect([...seen].sort()).toEqual(JOBS.map((j) => j.name).sort());
  });
});

describe("tickKey", () => {
  it("is stable within a 10-minute bucket and differs across buckets", () => {
    expect(tickKey("fx-sync", bkk(7, 0), TZ)).toBe(tickKey("fx-sync", bkk(7, 9), TZ));
    expect(tickKey("fx-sync", bkk(7, 0), TZ)).not.toBe(tickKey("fx-sync", bkk(7, 10), TZ));
  });
  it("uses the local calendar date near midnight (not UTC)", () => {
    // 00:30 Asia/Bangkok = previous calendar day in UTC
    const key = tickKey("fx-sync", bkk(0, 30), TZ);
    expect(key).toContain("2026-09-15T0030");
    expect(key).not.toContain("2026-09-14");
  });
});
