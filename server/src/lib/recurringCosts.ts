// Pure helpers for manually tracked recurring costs. Dates are YYYY-MM-DD strings.
import { normalizeMerchant } from './categories';
import { daysInMonth, diffDays } from './dates';

export type RecurringStatus = 'paid' | 'due_soon' | 'upcoming' | 'overdue';

export const AMOUNT_TOLERANCE = 0.15;
export const DUE_SOON_DAYS = 5;

export interface CostLike { name: string; amount: number; dayOfMonth: number; matchMerchant?: string | null }
export interface PaymentTx { id: string; date: string; amount: number; merchantName: string | null; name: string }

/** The date the cost falls due in `month` (YYYY-MM), with the day clamped to the month's length. */
export function dueDateIn(month: string, dayOfMonth: number): string {
  return `${month}-${String(Math.min(Math.max(1, dayOfMonth), daysInMonth(month))).padStart(2, '0')}`;
}

/** The normalized string used to recognise a cost's payments. */
export function costKey(c: Pick<CostLike, 'name' | 'matchMerchant'>): string {
  return normalizeMerchant(c.matchMerchant || c.name);
}

/** Normalized merchants match when equal, or when one appears in the other on whole hyphen-delimited words ("netflix" in "netflix-com-8665"). */
export function merchantMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return `-${a}-`.includes(`-${b}-`) || `-${b}-`.includes(`-${a}-`);
}

/** The best paying transaction among `txs` (already limited to the month): matching merchant, money out, amount within +/-15%. Closest amount wins. */
export function findPayment(cost: CostLike, txs: PaymentTx[]): PaymentTx | null {
  const key = costKey(cost);
  if (!key || !(cost.amount > 0)) return null;
  let best: PaymentTx | null = null;
  for (const t of txs) {
    if (t.amount <= 0) continue;
    if (Math.abs(t.amount - cost.amount) > cost.amount * AMOUNT_TOLERANCE + 1e-9) continue;
    const hit = merchantMatches(normalizeMerchant(t.merchantName), key) || merchantMatches(normalizeMerchant(t.name), key);
    if (!hit) continue;
    if (!best || Math.abs(t.amount - cost.amount) < Math.abs(best.amount - cost.amount)) best = t;
  }
  return best;
}

/** paid > overdue (due date passed) > due soon (within 5 days) > upcoming. */
export function statusFor(dueDate: string, today: string, paid: boolean): RecurringStatus {
  if (paid) return 'paid';
  if (today > dueDate) return 'overdue';
  return diffDays(dueDate, today) <= DUE_SOON_DAYS ? 'due_soon' : 'upcoming';
}

/** First due date on or after `from` for a monthly cost; `skipThisMonth` moves on to the following month (cost already paid). */
export function nextDueOnOrAfter(dayOfMonth: number, from: string, skipThisMonth = false): string {
  const month = from.slice(0, 7);
  const due = dueDateIn(month, dayOfMonth);
  if (!skipThisMonth && due >= from) return due;
  const [y, m] = month.split('-').map(Number);
  const t = y * 12 + m; // zero-based index of the following month
  return dueDateIn(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`, dayOfMonth);
}
