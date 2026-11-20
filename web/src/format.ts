export const TZ = 'America/Denver';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0, minimumFractionDigits: 0 });

const neg = (n: number) => n < 0 && Math.abs(n) >= 0.005;
export const money = (n: number) => (neg(n) ? '−' + usd.format(-n) : usd.format(Math.abs(n) < 0.005 ? 0 : n));
export const money0 = (n: number) => (n < 0 ? '−' + usd0.format(-n) : usd0.format(n));
/** always-signed delta, e.g. +$3,214.08 / −$12.00 */
export const signed = (n: number) => (neg(n) ? '−' : '+') + usd.format(Math.abs(n));
/** liability display: −$2,140.12 */
export const liability = (n: number) => (Math.abs(n) < 0.005 ? usd.format(0) : '−' + usd.format(Math.abs(n)));

export function splitMoney(n: number) {
  const s = usd.format(Math.abs(n));
  const i = s.lastIndexOf('.');
  return { sign: neg(n) ? '−' : '', whole: s.slice(0, i), cents: s.slice(i) };
}

/** YYYY-MM-DD -> Date at noon UTC (same calendar day in Denver) */
const day = (d: string) => new Date(d + 'T12:00:00Z');
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...o });

export const todayLong = () => fmt({ weekday: 'long', month: 'short', day: 'numeric' }).format(new Date());
export const fullDay = (d: string) => fmt({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(day(d));
export const shortDay = (d: string) => fmt({ month: 'short', day: 'numeric' }).format(day(d));
export const chartDay = (d: string) => fmt({ month: 'short', day: 'numeric', year: 'numeric' }).format(day(d));
export const monthLong = (ym: string) => fmt({ month: 'long' }).format(day(ym + '-15'));
export const monthShort = (ym: string) => fmt({ month: 'short' }).format(day(ym + '-15'));
export const monthYear = (ym: string) => fmt({ month: 'long', year: 'numeric' }).format(day(ym + '-15'));

export function currentMonth(): string {
  const p = fmt({ year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}`;
}
export function recentMonths(n = 12): string[] {
  const [y, m] = currentMonth().split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

export function greeting(): string {
  const h = Number(fmt({ hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  return 'Good evening';
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
