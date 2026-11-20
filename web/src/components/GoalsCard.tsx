import { useState } from 'react';
import { money0, monthYearShort } from '../format';
import { useAccounts, useGoals } from '../hooks';
import type { Goal, GoalPace } from '../types';
import { ErrorBanner, Loading, Skeleton } from './bits';
import { GoalSheet } from './GoalSheet';

export const PACE: Record<GoalPace, { label: string; cls: string } | null> = {
  on_track: { label: 'On track', cls: 'soft' },
  ahead: { label: 'Ahead', cls: 'pos' },
  behind: { label: 'Behind', cls: 'neg' },
  done: { label: 'Done', cls: 'pos' },
  no_date: null,
};

/** 36px version of the Budgets ring: gold on --track, --positive when done. */
export function GoalRing({ pct, done, label }: { pct: number; done: boolean; label: string }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 36 36" width="36" height="36" role="img" aria-label={label} style={{ flexShrink: 0, display: 'block' }}>
      <circle cx="18" cy="18" r={r} fill="none" stroke="var(--track)" strokeWidth="4" />
      <circle cx="18" cy="18" r={r} fill="none" stroke={done ? 'var(--positive)' : 'var(--gold)'} strokeWidth="4" strokeLinecap="round"
        strokeDasharray={`${(Math.min(100, Math.max(0, pct)) / 100) * c} ${c + 1}`} transform="rotate(-90 18 18)" />
    </svg>
  );
}

export function GoalsCard() {
  const q = useGoals();
  const acc = useAccounts();
  const [sheet, setSheet] = useState<{ goal?: Goal } | null>(null);
  const goals = q.data?.goals ?? [];

  return (
    <>
      <section id="goals" aria-label="Goals" className="card" style={{ scrollMarginTop: 56 }}>
        <div className="card-head">
          <h2>Goals</h2>
          <button className="textlink" onClick={() => setSheet({})}>New goal</button>
        </div>
        {q.isPending && (<><Loading /><Skeleton h={48} style={{ marginBottom: 12 }} /></>)}
        {q.isError && !q.data && <div style={{ paddingBottom: 10 }}><ErrorBanner message="Couldn't load goals." onRetry={() => q.refetch()} /></div>}
        {q.data && goals.length === 0 && <p className="muted" style={{ fontSize: 14, padding: '2px 0 14px' }}>Set a goal to track your savings</p>}
        {goals.map((g) => {
          const tag = PACE[g.pace];
          const pace = tag?.label ?? 'no target date';
          return (
            <button key={g.id} className="row press" onClick={() => setSheet({ goal: g })}
              aria-label={`${g.name}, ${money0(g.current)} of ${money0(g.targetAmount)}, ${pace}. Edit`}>
              <GoalRing pct={g.pct} done={g.pace === 'done'} label={`${Math.round(g.pct)} percent saved`} />
              <span className="row-mid">
                <span className="row-title">{g.name}</span>
                <span className="row-sub tnum">{money0(g.current)} of {money0(g.targetAmount)}{g.targetDate ? ` · by ${monthYearShort(g.targetDate)}` : ''}</span>
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                {tag && <span className={`tag ${tag.cls}`} style={{ fontSize: 13 }}>{tag.label}</span>}
                {g.monthlyNeeded != null && g.pace !== 'done' && <span className="muted tnum" style={{ fontSize: 12 }}>{money0(g.monthlyNeeded)}/mo needed</span>}
              </span>
            </button>
          );
        })}
      </section>
      {sheet && <GoalSheet goal={sheet.goal} accounts={acc.data?.groups.flatMap((g) => g.accounts) ?? []} onClose={() => setSheet(null)} />}
    </>
  );
}
