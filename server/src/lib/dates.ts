// All date math is done on YYYY-MM-DD strings, with "today" resolved in APP_TIMEZONE.
import { getConfig } from './config';

export type Range = '1M' | '3M' | '1Y' | 'ALL';

export function todayStr(now: Date = new Date(), tz: string = getConfig().timezone): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const parse = (s: string): Date => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fmt = (d: Date): string => d.toISOString().slice(0, 10);

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(date: string, n: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

/** Adds months, clamping the day to the end of the target month. `anchorDay` lets callers keep e.g. the 31st across short months. */
export function addMonths(date: string, n: number, anchorDay?: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const day = anchorDay ?? d;
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const ym = `${ny}-${String(nm).padStart(2, '0')}`;
  return `${ym}-${String(Math.min(day, daysInMonth(ym))).padStart(2, '0')}`;
}

export function diffDays(a: string, b: string): number {
  return Math.round((parse(a).getTime() - parse(b).getTime()) / 86400000);
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: string): string {
  const dow = parse(date).getUTCDay(); // 0=Sun
  return addDays(date, -((dow + 6) % 7));
}

/** Days remaining in `month` after `today` (0 for past months, full length for future months). */
export function daysLeftInMonth(month: string, today: string): number {
  const cur = monthOf(today);
  if (month < cur) return 0;
  if (month > cur) return daysInMonth(month);
  return daysInMonth(month) - Number(today.slice(8, 10));
}

export function isMonth(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

export function rangeStart(range: Range, today: string): string | null {
  switch (range) {
    case '1M': return addMonths(today, -1);
    case '3M': return addMonths(today, -3);
    case '1Y': return addMonths(today, -12);
    default: return null;
  }
}

export function rangeLabel(range: Range): string {
  return { '1M': 'past month', '3M': 'past 3 months', '1Y': 'past year', ALL: 'all time' }[range];
}

/** "Today" | "Yesterday" | "Tue, Nov 17" */
export function dayLabel(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(parse(date));
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fmt(parse(s)) === s;
}
