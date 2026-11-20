import { useState } from 'react';
import { currentMonth, money, money0, monthLong, plural, shortDay } from '../format';
import { useBudgets, useCashflow } from '../hooks';
import { Ico } from '../icons';
import type { Cashflow } from '../types';
import { ErrorBanner, Loading, Skeleton } from '../components/bits';
import { BudgetEditSheet } from '../components/BudgetEditSheet';
import { ForecastSheet } from '../components/ForecastSheet';
import { MonthPicker } from '../components/MonthPicker';
import { RecurringCard } from '../components/RecurringCard';

const C = 2 * Math.PI * 54;

function MiniBars({ weekly }: { weekly: Cashflow['weekly'] }) {
  if (!weekly.length) return <svg viewBox="0 0 96 48" width="96" height="48" aria-hidden="true" />;
  const vals = weekly.map((w) => w.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pitch = 96 / weekly.length;
  const bw = Math.min(10, pitch * 0.62);
  return (
    <svg viewBox="0 0 96 48" width="96" height="48" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      {weekly.map((w, i) => {
        const h = max === min ? 28 : 10 + ((w.value - min) / (max - min)) * 34;
        return <rect key={w.weekStart} x={i * pitch + (pitch - bw) / 2} y={48 - h} width={bw} height={h} rx="2" fill={w.projected ? '#C9A86A' : 'rgba(239,232,216,0.55)'} />;
      })}
    </svg>
  );
}

export default function Budgets() {
  const [month, setMonth] = useState(currentMonth);
  const [picker, setPicker] = useState(false);
  const [edit, setEdit] = useState(false);
  const [forecast, setForecast] = useState(false);
  const b = useBudgets(month);
  const cf = useCashflow();
  const d = b.data;
  const ratio = d && d.limit > 0 ? d.spent / d.limit : 0;
  const pct = Math.round(ratio * 100);

  return (
    <>
      <main className="screen">
        <div className="title-row">
          <h1 className="h1">Budgets</h1>
          <button className="pill-btn" onClick={() => setPicker(true)} aria-haspopup="dialog">
            {monthLong(month)}<Ico name="chevron" size={14} sw={2} />
          </button>
        </div>

        {b.isPending && (<><Loading /><Skeleton h={156} r={20} /><Skeleton h={300} r={20} /></>)}
        {b.isError && !d && <ErrorBanner message="Couldn't load budgets." onRetry={() => b.refetch()} />}

        {d && (
          <>
            <section aria-label="Month overview" className="card" style={{ display: 'flex', alignItems: 'center', gap: 18, padding: 16 }}>
              <svg viewBox="0 0 128 128" width="124" height="124" role="img" aria-label={d.limit > 0 ? `${pct} percent of monthly budget spent` : 'No monthly budget set'} style={{ flexShrink: 0, display: 'block' }}>
                <circle cx="64" cy="64" r="54" fill="none" stroke="rgba(201,168,106,0.14)" strokeWidth="10" />
                <circle cx="64" cy="64" r="54" fill="none" stroke={ratio > 1 ? '#E08A5F' : '#C9A86A'} strokeWidth="10" strokeLinecap="round"
                  strokeDasharray={`${Math.min(1, ratio) * C} ${C + 1}`} transform="rotate(-90 64 64)" />
                <text x="64" y="62" textAnchor="middle" fontFamily="Cormorant Garamond, serif" fontSize="30" fontWeight="600" fill="#EFE8D8" style={{fontVariantNumeric:'lining-nums'}}>{d.limit > 0 ? `${pct}%` : '—'}</text>
                <text x="64" y="82" textAnchor="middle" fontFamily="Inter, sans-serif" fontSize="11" fill="#9BA59E">spent</text>
              </svg>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                <span className="label">{d.left < 0 ? 'Over budget' : 'Left to spend'}</span>
                <span className="serif tnum" style={{ fontSize: 36, fontWeight: 600, lineHeight: 1 }}>{money(Math.abs(d.left))}</span>
                <span className="muted tnum" style={{ fontSize: 13 }}>
                  {d.limit > 0 ? `${money0(d.spent)} of ${money0(d.limit)}` : `${money0(d.spent)} spent`} · {plural(d.daysLeft, 'day')} left
                </span>
              </div>
            </section>

            <section aria-label="Categories" className="card" style={{ padding: '6px 16px 10px' }}>
              <div className="card-head" style={{ height: 42 }}>
                <h2>Categories</h2>
                <button className="textlink" onClick={() => setEdit(true)}>Edit</button>
              </div>
              {d.categories.length === 0 && <p className="muted" style={{ fontSize: 14, padding: '8px 0 12px' }}>No spending or limits yet this month.</p>}
              {d.categories.map((c) => {
                const lim = c.limit ?? 0;
                const over = lim > 0 && c.spent > lim;
                const w = lim > 0 ? Math.min(1, Math.max(0, c.spent) / lim) * 100 : 0;
                return (
                  <div key={c.key} style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '9px 0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{ fontSize: 15, fontWeight: 500 }}>{c.label}</span>
                      {over
                        ? <span className="neg tnum" style={{ fontSize: 13, fontWeight: 600 }}>Over by {money0(c.spent - lim)}</span>
                        : <span className="muted tnum" style={{ fontSize: 13 }}>{lim > 0 ? `${money0(c.spent)} / ${money0(lim)}` : `${money0(c.spent)} · no limit`}</span>}
                    </div>
                    <div className="bar" role="presentation"><i className={over ? 'over' : ''} style={{ width: `${w}%` }} /></div>
                  </div>
                );
              })}
            </section>
          </>
        )}

        <RecurringCard month={month} />

        {cf.isPending && <Skeleton h={92} r={20} />}
        {cf.isError && <ErrorBanner message="Couldn't load the forecast." onRetry={() => cf.refetch()} />}
        {cf.data && (
          <button aria-label="Open cash flow forecast" className="card press" onClick={() => setForecast(true)}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', textAlign: 'left', color: 'var(--ivory)', width: '100%' }}>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="label">Cash on {shortDay(cf.data.horizonDate)}</span>
              <span className="serif tnum" style={{ fontSize: 28, fontWeight: 600 }}>{money0(cf.data.projected)}</span>
              <span className="row-sub">Forecast · {plural(cf.data.bills, 'bill')}, {plural(cf.data.paydays, 'payday')} ahead</span>
            </span>
            <MiniBars weekly={cf.data.weekly} />
          </button>
        )}
      </main>
      {picker && <MonthPicker value={month} onPick={setMonth} onClose={() => setPicker(false)} />}
      {edit && d && <BudgetEditSheet budgets={d} onClose={() => setEdit(false)} />}
      {forecast && cf.data && <ForecastSheet cf={cf.data} onClose={() => setForecast(false)} />}
    </>
  );
}
