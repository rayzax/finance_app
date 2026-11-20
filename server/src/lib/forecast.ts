// Pure cash-flow projection. Dates are YYYY-MM-DD strings.
import { normalizeMerchant } from './categories';
import { addDays, addMonths, diffDays, startOfWeek } from './dates';
import { costKey, merchantMatches, nextDueOnOrAfter } from './recurringCosts';

export type Frequency = 'WEEKLY' | 'BIWEEKLY' | 'SEMI_MONTHLY' | 'MONTHLY' | 'ANNUALLY' | 'UNKNOWN' | string;

export interface Stream {
  streamId?: string;
  description: string;
  frequency: Frequency;
  lastDate?: string | null;
  predictedNextDate?: string | null;
  averageAmount: number; // absolute value
  isActive?: boolean;
  status?: string;
  direction: 'in' | 'out';
}

/** A manually tracked monthly cost. `paidThisMonth` skips the current month's occurrence (cash already left the account). */
export interface ManualCost {
  name: string;
  amount: number;
  dayOfMonth: number;
  matchMerchant?: string | null;
  paidThisMonth?: boolean;
}

export interface Upcoming { date: string; description: string; amount: number; direction: 'in' | 'out' }

/** The date of the occurrence following `date` (non-month-based frequencies, and MONTHLY/ANNUALLY approximations). */
export function nextOccurrence(date: string, freq: Frequency, anchorDay?: number): string | null {
  switch (freq) {
    case 'WEEKLY': return addDays(date, 7);
    case 'BIWEEKLY': return addDays(date, 14);
    case 'MONTHLY': return addMonths(date, 1, anchorDay);
    case 'ANNUALLY': return addMonths(date, 12, anchorDay);
    default: return null;
  }
}

function semiMonthlyDates(anchor: string, from: string, to: string): string[] {
  const day = Number(anchor.slice(8, 10));
  const low = day > 15 ? day - 15 : day;
  const high = low + 15;
  const out: string[] = [];
  let monthStart = `${anchor.slice(0, 7)}-01`;
  while (monthStart <= to) {
    for (const d of [low, high]) {
      const c = addMonths(monthStart, 0, d);
      if (c >= anchor && c >= from && c <= to) out.push(c);
    }
    monthStart = addMonths(monthStart, 1, 1);
  }
  return out;
}

/**
 * The day-of-month a MONTHLY/ANNUALLY stream keeps. Taken from lastDate (the original anchor day)
 * when present, so a clamped predictedNextDate (e.g. Feb 28 from Jan 31) does not shift the schedule.
 */
function monthlyAnchorDay(s: Pick<Stream, 'lastDate'>, anchor: string): number {
  return Number((s.lastDate ?? anchor).slice(8, 10));
}

/** The first expected occurrence: predictedNextDate, else lastDate + one period. */
export function streamAnchor(s: Pick<Stream, 'frequency' | 'lastDate' | 'predictedNextDate'>): string | null {
  if (s.predictedNextDate) return s.predictedNextDate;
  if (s.lastDate) {
    if (s.frequency === 'SEMI_MONTHLY') return addDays(s.lastDate, 15);
    if (s.frequency === 'MONTHLY' || s.frequency === 'ANNUALLY') {
      return nextOccurrence(s.lastDate, s.frequency, Number(s.lastDate.slice(8, 10)));
    }
    return nextOccurrence(s.lastDate, s.frequency);
  }
  return null;
}

/** All occurrence dates of a stream within [from, to] inclusive. */
export function occurrencesBetween(s: Pick<Stream, 'frequency' | 'lastDate' | 'predictedNextDate'>, from: string, to: string): string[] {
  const anchor = streamAnchor(s);
  if (!anchor || anchor > to) return [];
  if (s.frequency === 'SEMI_MONTHLY') return semiMonthlyDates(anchor, from, to);
  if (s.frequency === 'WEEKLY' || s.frequency === 'BIWEEKLY') {
    const step = s.frequency === 'WEEKLY' ? 7 : 14;
    let d = anchor;
    if (d < from) d = addDays(d, Math.ceil(diffDays(from, d) / step) * step);
    const out: string[] = [];
    for (; d <= to; d = addDays(d, step)) out.push(d);
    return out;
  }
  if (s.frequency === 'MONTHLY' || s.frequency === 'ANNUALLY') {
    const anchorDay = monthlyAnchorDay(s, anchor);
    const out: string[] = [];
    let d = anchor;
    for (let i = 0; i < 1000 && d <= to; i++) {
      if (d >= from) out.push(d);
      const n = nextOccurrence(d, s.frequency, anchorDay);
      if (!n) break;
      d = n;
    }
    return out;
  }
  // UNKNOWN: only a single predicted occurrence, if it lands in the window.
  return anchor >= from && anchor <= to ? [anchor] : [];
}

export function projectStreams(streams: Stream[], from: string, to: string): Upcoming[] {
  const out: Upcoming[] = [];
  for (const s of streams) {
    if (s.isActive === false || s.status === 'TOMBSTONED') continue;
    if (!Number.isFinite(s.averageAmount) || s.averageAmount <= 0) continue;
    for (const date of occurrencesBetween(s, from, to)) {
      out.push({ date, description: s.description, amount: round2(s.averageAmount), direction: s.direction });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Monthly outflow streams for manual costs. The day-of-month is kept in lastDate (a day-31-safe anchor) so short months clamp without drifting. */
export function manualCostStreams(costs: ManualCost[], asOf: string): Stream[] {
  return costs
    .filter((c) => c.amount > 0)
    .map((c) => ({
      description: c.name,
      frequency: 'MONTHLY',
      averageAmount: c.amount,
      direction: 'out' as const,
      isActive: true,
      predictedNextDate: nextDueOnOrAfter(c.dayOfMonth, asOf, !!c.paidThisMonth),
      lastDate: `2000-01-${String(Math.min(c.dayOfMonth, 31)).padStart(2, '0')}`,
    }));
}

/** Plaid streams plus manual costs; a Plaid outflow stream for the same merchant as a manual cost is dropped (the manual cost wins). */
export function mergeManualCosts(streams: Stream[], costs: ManualCost[], asOf: string): Stream[] {
  const keys = costs.flatMap((c) => [costKey(c), normalizeMerchant(c.name)]).filter(Boolean);
  const kept = streams.filter((s) => {
    if (s.direction !== 'out') return true;
    const d = normalizeMerchant(s.description);
    return !keys.some((k) => merchantMatches(d, k));
  });
  return [...kept, ...manualCostStreams(costs, asOf)];
}

export interface ForecastInput {
  cashNow: number;
  streams: Stream[];
  /** Active manual recurring costs, merged into `streams` without double counting. */
  manualCosts?: ManualCost[];
  asOf: string;
  horizonDays?: number; // default 30
  projectedWeeks?: number; // default 4
  /** Actual end-of-day cash history, ascending by date (from snapshots). */
  cashHistory?: { date: string; cash: number }[];
  pastWeeks?: number; // default 4
}

export interface Forecast {
  asOf: string;
  horizonDate: string;
  cashNow: number;
  projected: number;
  bills: number;
  paydays: number;
  upcoming: Upcoming[];
  weekly: { weekStart: string; value: number; projected: boolean }[];
}

export function buildForecast(input: ForecastInput): Forecast {
  const { cashNow, asOf } = input;
  const streams = input.manualCosts?.length ? mergeManualCosts(input.streams, input.manualCosts, asOf) : input.streams;
  const horizon = input.horizonDays ?? 30;
  const horizonDate = addDays(asOf, horizon);
  const nProj = input.projectedWeeks ?? 4;
  const nPast = input.pastWeeks ?? 4;

  const thisWeek = startOfWeek(asOf);
  const lastWeekEnd = addDays(thisWeek, 7 * nProj + 6);
  const all = projectStreams(streams, asOf, lastWeekEnd > horizonDate ? lastWeekEnd : horizonDate);
  const upcoming = all.filter((u) => u.date <= horizonDate);

  const net = (list: Upcoming[]) => list.reduce((s, u) => s + (u.direction === 'in' ? u.amount : -u.amount), 0);
  const projected = round2(cashNow + net(upcoming));

  const weekly: Forecast['weekly'] = [];
  const hist = input.cashHistory ?? [];
  for (let i = nPast; i >= 1; i--) {
    const weekStart = addDays(thisWeek, -7 * i);
    const weekEnd = addDays(weekStart, 6);
    let v: number | undefined;
    for (const h of hist) if (h.date <= weekEnd) v = h.cash; else break;
    if (v !== undefined) weekly.push({ weekStart, value: round2(v), projected: false });
  }
  weekly.push({ weekStart: thisWeek, value: round2(cashNow), projected: false });
  for (let i = 1; i <= nProj; i++) {
    const weekStart = addDays(thisWeek, 7 * i);
    const weekEnd = addDays(weekStart, 6);
    weekly.push({ weekStart, value: round2(cashNow + net(all.filter((u) => u.date <= weekEnd)) ), projected: true });
  }

  return {
    asOf,
    horizonDate,
    cashNow: round2(cashNow),
    projected,
    bills: upcoming.filter((u) => u.direction === 'out').length,
    paydays: upcoming.filter((u) => u.direction === 'in').length,
    upcoming,
    weekly,
  };
}
