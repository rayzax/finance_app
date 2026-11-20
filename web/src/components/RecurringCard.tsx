import { useState } from 'react';
import { money, money0, shortDay } from '../format';
import { useRecurringCosts } from '../hooks';
import type { RecurringItem, RecurringStatus } from '../types';
import { ErrorBanner, Loading, Skeleton } from './bits';
import { RecurringSheet } from './RecurringSheet';

const TAG: Record<Exclude<RecurringStatus, 'upcoming'>, { label: string; cls: string }> = {
  paid: { label: 'Paid', cls: 'pos' },
  due_soon: { label: 'Due soon', cls: 'gold' },
  overdue: { label: 'Overdue', cls: 'neg' },
};

export function RecurringCard({ month }: { month: string }) {
  const q = useRecurringCosts(month);
  const [sheet, setSheet] = useState<{ item?: RecurringItem } | null>(null);
  const d = q.data;
  const paidPct = d && d.totalMonthly > 0 ? Math.min(100, (d.paidAmount / d.totalMonthly) * 100) : 0;

  return (
    <>
      <section aria-label="Recurring" className="card" style={{ padding: '6px 16px 6px' }}>
        <div className="card-head" style={{ height: 42 }}>
          <h2>Recurring</h2>
          <button className="textlink" onClick={() => setSheet({})}>Add</button>
        </div>
        {q.isPending && (<><Loading /><Skeleton h={14} w="60%" style={{ marginBottom: 12 }} /><Skeleton h={44} style={{ marginBottom: 10 }} /></>)}
        {q.isError && !d && <div style={{ paddingBottom: 10 }}><ErrorBanner message="Couldn't load recurring costs." onRetry={() => q.refetch()} /></div>}
        {d && d.items.length === 0 && <p className="muted" style={{ fontSize: 14, padding: '2px 0 12px' }}>Track bills and subscriptions to see what's due.</p>}
        {d && d.items.length > 0 && (
          <>
            <p className="muted tnum" style={{ fontSize: 13 }}>
              {money0(d.totalMonthly)} / month · {d.paidCount} paid · {d.upcomingCount} upcoming
            </p>
            <div className="bar" style={{ margin: '8px 0 6px' }} role="img" aria-label={`${Math.round(paidPct)} percent of recurring costs paid this month`}>
              <i style={{ width: `${paidPct}%` }} />
            </div>
            {d.items.map((it) => {
              const tag = it.active && it.status !== 'upcoming' ? TAG[it.status] : null;
              const paid = it.active && it.status === 'paid' && it.paidDate;
              return (
                <button key={it.id} className="row press" style={{ opacity: it.active ? 1 : 0.6 }} onClick={() => setSheet({ item: it })} aria-label={`Edit ${it.name}`}>
                  <span className="row-mid">
                    <span className="row-title">{it.name}</span>
                    <span className="row-sub">{!it.active ? 'Paused' : paid ? `Paid ${shortDay(it.paidDate!)}` : `Due ${shortDay(it.dueDate)}`}</span>
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                    <span className="row-amt">{money(it.amount)}</span>
                    {tag && <span className={`tag ${tag.cls}`}>{tag.label}</span>}
                  </span>
                </button>
              );
            })}
          </>
        )}
      </section>
      {sheet && <RecurringSheet item={sheet.item} detected={d?.detected} onClose={() => setSheet(null)} />}
    </>
  );
}
