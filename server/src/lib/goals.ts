// Pure savings-goal math. Dates are YYYY-MM-DD strings; "today" is always passed in (APP_TIMEZONE is resolved by callers).
import { addDays, diffDays } from './dates';

export type Pace = 'ahead' | 'on_track' | 'behind' | 'done' | 'no_date';

/** Percentage points a goal may lead or trail the linear schedule before it counts as ahead / behind. */
export const PACE_TOLERANCE = 5;
const DAYS_PER_MONTH = 30.4375;
/** Savings-rate lookback. */
export const RATE_WINDOW_DAYS = 90;
const MAX_PROJECTION_DAYS = 365 * 50;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Whole months left until `targetDate`, rounded up, never below 1 (also for dates that have already passed). */
export function monthsLeft(today: string, targetDate: string): number {
  return Math.max(1, Math.ceil(diffDays(targetDate, today) / DAYS_PER_MONTH));
}

/** Where a goal should be on the straight line from createdDate to targetDate, 0..100. */
export function expectedPct(createdDate: string, targetDate: string, today: string): number {
  const total = diffDays(targetDate, createdDate);
  if (today >= targetDate || total <= 0) return 100;
  return round1(clamp((diffDays(today, createdDate) / total) * 100, 0, 100));
}

export interface GoalEvalInput {
  current: number;
  targetAmount: number;
  createdDate: string;
  targetDate: string | null;
  today: string;
}

export interface GoalEval {
  pct: number;
  remaining: number;
  monthlyNeeded: number | null;
  expectedPct: number | null;
  pace: Pace;
}

export function evaluateGoal(i: GoalEvalInput): GoalEval {
  const { current, targetAmount: target } = i;
  const rawPct = target > 0 ? (current / target) * 100 : 100;
  const pct = round1(clamp(rawPct, 0, 100));
  const remaining = round2(Math.max(0, target - current));
  if (current >= target) {
    return { pct: 100, remaining: 0, monthlyNeeded: null, expectedPct: i.targetDate ? expectedPct(i.createdDate, i.targetDate, i.today) : null, pace: 'done' };
  }
  if (!i.targetDate) return { pct, remaining, monthlyNeeded: null, expectedPct: null, pace: 'no_date' };

  const exp = expectedPct(i.createdDate, i.targetDate, i.today);
  const clampedRaw = clamp(rawPct, 0, 100);
  const pace: Pace = clampedRaw >= exp + PACE_TOLERANCE ? 'ahead' : clampedRaw < exp - PACE_TOLERANCE ? 'behind' : 'on_track';
  return { pct, remaining, monthlyNeeded: round2(remaining / monthsLeft(i.today, i.targetDate)), expectedPct: exp, pace };
}

/** Dollars per day from a balance series: change between the first and last point inside the window. null when it spans under 7 days. */
export function savingsRatePerDay(points: { date: string; value: number }[], today: string, windowDays = RATE_WINDOW_DAYS): number | null {
  const from = addDays(today, -windowDays);
  const inWin = points.filter((p) => p.date >= from && p.date <= today).sort((a, b) => a.date.localeCompare(b.date));
  if (inWin.length < 2) return null;
  const first = inWin[0];
  const last = inWin[inWin.length - 1];
  const span = diffDays(last.date, first.date);
  if (span < 7) return null;
  return (last.value - first.value) / span;
}

/**
 * Dollars per day from manual contributions: the net of contributions inside the window divided by the days
 * since the earliest of them (clamped to 30..window days, so one lump sum is not read as a huge daily rate).
 */
export function contributionRatePerDay(contribs: { date: string; amount: number }[], today: string, windowDays = RATE_WINDOW_DAYS): number | null {
  const from = addDays(today, -windowDays);
  const inWin = contribs.filter((c) => c.date >= from && c.date <= today);
  if (!inWin.length) return null;
  const earliest = inWin.reduce((m, c) => (c.date < m ? c.date : m), inWin[0].date);
  const span = clamp(diffDays(today, earliest), 30, windowDays);
  return inWin.reduce((s, c) => s + c.amount, 0) / span;
}

/** The date the goal is reached at the given rate, or null when the rate is not positive (or absurdly far out). */
export function projectDate(current: number, targetAmount: number, ratePerDay: number | null, today: string): string | null {
  if (ratePerDay === null || !Number.isFinite(ratePerDay) || ratePerDay <= 0) return null;
  const remaining = targetAmount - current;
  if (remaining <= 0) return today;
  const days = Math.ceil(remaining / ratePerDay);
  return days > MAX_PROJECTION_DAYS ? null : addDays(today, days);
}

export interface GoalSummary { totalSaved: number; totalTarget: number; onTrack: number; behind: number }

/** Overall saved is capped per goal so an over-funded goal cannot hide a shortfall elsewhere. Goals without a date count as neither on track nor behind. */
export function summarizeGoals(goals: { current: number; targetAmount: number; pace: Pace }[]): GoalSummary {
  return {
    totalSaved: round2(goals.reduce((s, g) => s + clamp(g.current, 0, g.targetAmount), 0)),
    totalTarget: round2(goals.reduce((s, g) => s + g.targetAmount, 0)),
    onTrack: goals.filter((g) => g.pace === 'ahead' || g.pace === 'on_track' || g.pace === 'done').length,
    behind: goals.filter((g) => g.pace === 'behind').length,
  };
}
