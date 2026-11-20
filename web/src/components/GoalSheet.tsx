import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../api';
import { money, monthYearShort } from '../format';
import { Ico } from '../icons';
import type { Account, Goal } from '../types';
import { Sheet } from './Sheet';
import { ErrorBanner } from './bits';

const NOT_SAVINGS = new Set(['credit', 'loans']);
const parseAmount = (raw: string) => Number(raw.replace(/[$,\s]/g, ''));

export function GoalSheet({ goal, accounts, onClose }: { goal?: Goal; accounts: Account[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(goal?.name ?? '');
  const [target, setTarget] = useState(goal ? String(goal.targetAmount) : '');
  const [date, setDate] = useState(goal?.targetDate ?? '');
  const [source, setSource] = useState<'accounts' | 'manual'>(goal?.source ?? 'accounts');
  const [picked, setPicked] = useState<string[]>(goal?.accountIds ?? []);
  const [onlyNew, setOnlyNew] = useState(goal?.countOnlyNew ?? false);
  const [startAmount, setStartAmount] = useState(goal && goal.source === 'manual' ? String(goal.manualAmount || '') : '');
  const [contrib, setContrib] = useState('');
  const [manualNow, setManualNow] = useState(goal?.source === 'manual' ? goal.current : 0);
  const [confirm, setConfirm] = useState(false);
  const [bad, setBad] = useState<string | null>(null);

  // asset accounts, plus any account this goal already links to
  const list = accounts.filter((a) => !NOT_SAVINGS.has(a.group) || picked.includes(a.id));
  const pickedTotal = list.filter((a) => picked.includes(a.id)).reduce((s, a) => s + (a.current ?? 0), 0);

  const refresh = () => qc.invalidateQueries({ queryKey: ['goals'] });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      goal ? api(`/api/goals/${encodeURIComponent(goal.id)}`, { method: 'PATCH', body }) : api('/api/goals', { method: 'POST', body }),
    onSuccess: async () => { await refresh(); onClose(); },
  });
  const del = useMutation({
    mutationFn: () => api(`/api/goals/${encodeURIComponent(goal!.id)}`, { method: 'DELETE' }),
    onSuccess: async () => { await refresh(); onClose(); },
  });
  const add = useMutation({
    mutationFn: (amount: number) => api<Goal>(`/api/goals/${encodeURIComponent(goal!.id)}/contribute`, { method: 'POST', body: { amount } }),
    onSuccess: async (g) => { setManualNow(g.current); setContrib(''); await refresh(); },
  });

  const submit = () => {
    const t = parseAmount(target);
    if (!name.trim()) return setBad('Enter a name.');
    if (!Number.isFinite(t) || t <= 0) return setBad('Enter a target above zero.');
    if (source === 'accounts' && picked.length === 0) return setBad('Choose at least one account.');
    const start = startAmount.trim() ? parseAmount(startAmount) : 0;
    if (source === 'manual' && (!Number.isFinite(start) || start < 0)) return setBad('Enter a valid amount saved so far.');
    setBad(null);
    save.mutate({
      name: name.trim(), targetAmount: Math.round(t * 100) / 100, targetDate: date || null, source,
      ...(source === 'accounts' ? { accountIds: picked, countOnlyNew: onlyNew } : { manualAmount: Math.round(start * 100) / 100 }),
    });
  };

  const contribute = () => {
    const n = parseAmount(contrib.replace('−', '-'));
    if (!Number.isFinite(n) || n === 0) return setBad('Enter an amount to add (negative for a withdrawal).');
    setBad(null);
    add.mutate(Math.round(n * 100) / 100);
  };

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <Sheet title={goal ? 'Edit goal' : 'New goal'} onClose={onClose}>
      {goal && goal.pace !== 'done' && goal.projectedDate && (
        <p className="row-sub" style={{ fontSize: 13 }}>At your recent pace you'd reach this around {monthYearShort(goal.projectedDate)}.</p>
      )}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="label">Name</span>
        <input className="field" data-autofocus={goal ? undefined : ''} autoComplete="off" maxLength={80} placeholder="Emergency fund" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div style={{ display: 'flex', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0 }}>
          <span className="label">Target</span>
          <span style={{ position: 'relative' }}>
            <span aria-hidden="true" className="muted" style={{ position: 'absolute', left: 14, top: 0, height: 46, display: 'flex', alignItems: 'center' }}>$</span>
            <input className="field tnum" style={{ paddingLeft: 28 }} inputMode="decimal" autoComplete="off" placeholder="10,000" value={target} onChange={(e) => setTarget(e.target.value)} />
          </span>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0 }}>
          <span className="label">Date (optional)</span>
          <input className="field" type="date" aria-label="Target date, optional" style={{ fontSize: 16, minWidth: 0 }} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="label" id="goal-source">Progress from</span>
        <div className="seg" role="group" aria-labelledby="goal-source">
          <button aria-pressed={source === 'accounts'} onClick={() => setSource('accounts')}>Linked accounts</button>
          <button aria-pressed={source === 'manual'} onClick={() => setSource('manual')}>Manual</button>
        </div>
      </div>

      {source === 'accounts' ? (
        <>
          <div role="group" aria-label="Accounts" style={{ maxHeight: 240, overflowY: 'auto' }}>
            {list.length === 0 && <p className="muted" style={{ fontSize: 14 }}>Link an account first, or track this goal manually.</p>}
            {list.map((a) => (
              <button key={a.id} className="row press" role="checkbox" aria-checked={picked.includes(a.id)} onClick={() => toggle(a.id)}>
                <span className="check-box" aria-hidden="true">{picked.includes(a.id) && <Ico name="check" size={16} sw={2.4} />}</span>
                <span className="row-mid">
                  <span className="row-title">{a.name}{a.hidden ? ' (hidden)' : ''}</span>
                  <span className="row-sub">{a.institutionName}{a.mask ? ` ··${a.mask}` : ''}</span>
                </span>
                <span className="row-amt">{a.current === null ? '—' : money(a.current)}</span>
              </button>
            ))}
          </div>
          <button className="switch-row" role="switch" aria-checked={onlyNew} onClick={() => setOnlyNew((v) => !v)}>
            <span style={{ flex: 1 }}>
              <span className="row-title" style={{ display: 'block', whiteSpace: 'normal' }}>Count only new savings</span>
              <span className="row-sub">{onlyNew ? `Starts from $0, ignoring the ${money(pickedTotal)} already there` : 'Counts the full balance of the chosen accounts'}</span>
            </span>
            <span className="switch" aria-hidden="true" />
          </button>
        </>
      ) : goal && goal.source === 'manual' ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="label">Current amount</span>
            <span className="serif tnum" style={{ fontSize: 34, fontWeight: 600, lineHeight: 1 }}>{money(manualNow)}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label htmlFor="goal-contrib" className="label">Add contribution</label>
            <div style={{ display: 'flex', gap: 10 }}>
              <input id="goal-contrib" className="field tnum" style={{ flex: 1, minWidth: 0 }} inputMode="decimal" autoComplete="off" placeholder="250" value={contrib} onChange={(e) => setContrib(e.target.value)} />
              <button className="btn-ghost" style={{ color: 'var(--gold)', minWidth: 72 }} disabled={add.isPending} onClick={contribute}>{add.isPending ? 'Adding…' : 'Add'}</button>
            </div>
            <span className="row-sub">Use a negative amount for a withdrawal.</span>
          </div>
          {add.isError && <ErrorBanner message={errMsg(add.error)} />}
        </>
      ) : (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="label">Saved so far</span>
          <span style={{ position: 'relative' }}>
            <span aria-hidden="true" className="muted" style={{ position: 'absolute', left: 14, top: 0, height: 46, display: 'flex', alignItems: 'center' }}>$</span>
            <input className="field tnum" style={{ paddingLeft: 28 }} inputMode="decimal" autoComplete="off" placeholder="0" value={startAmount} onChange={(e) => setStartAmount(e.target.value)} />
          </span>
          <span className="row-sub">You can add contributions after saving.</span>
        </label>
      )}

      {bad && <ErrorBanner message={bad} />}
      {save.isError && <ErrorBanner message={errMsg(save.error)} />}
      {del.isError && <ErrorBanner message={errMsg(del.error)} />}
      <button className="btn-gold" disabled={save.isPending} onClick={submit}>{save.isPending ? 'Saving…' : goal ? 'Save changes' : 'Create goal'}</button>
      {goal && (!confirm
        ? <button className="btn-ghost" style={{ color: 'var(--over-text)', borderColor: 'rgba(238,154,110,.45)' }} onClick={() => setConfirm(true)}>Delete goal</button>
        : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="row-sub" style={{ marginRight: 'auto' }}>Delete {goal.name}?</span>
            <button className="btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn-ghost" style={{ color: 'var(--over-text)', borderColor: 'rgba(238,154,110,.45)' }} disabled={del.isPending} onClick={() => del.mutate()}>{del.isPending ? 'Deleting…' : 'Delete'}</button>
          </div>
        ))}
    </Sheet>
  );
}
