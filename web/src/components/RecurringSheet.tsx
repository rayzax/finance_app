import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../api';
import { money } from '../format';
import { useCategories } from '../hooks';
import type { DetectedStream, RecurringItem } from '../types';
import { Sheet } from './Sheet';
import { ErrorBanner } from './bits';

const SKIP = new Set(['income', 'transfer']);
const FREQ: Record<string, string> = { WEEKLY: 'Weekly', BIWEEKLY: 'Every 2 weeks', SEMI_MONTHLY: 'Twice a month', MONTHLY: 'Monthly', ANNUALLY: 'Yearly' };

const parseAmount = (raw: string) => Number(raw.replace(/[$,\s]/g, ''));
const dayFrom = (s: DetectedStream) => Number((s.predictedNextDate ?? s.lastDate ?? '').slice(8, 10)) || 1;

interface Props {
  /** The cost being edited; omit to add a new one. */
  item?: RecurringItem;
  detected?: DetectedStream[];
  onClose: () => void;
}

export function RecurringSheet({ item, detected = [], onClose }: Props) {
  const qc = useQueryClient();
  const cats = useCategories();
  const [name, setName] = useState(item?.name ?? '');
  const [amount, setAmount] = useState(item ? String(item.amount) : '');
  const [dayOfMonth, setDay] = useState(item ? String(item.dayOfMonth) : '');
  const [category, setCategory] = useState(item?.category ?? 'bills');
  const [merchant, setMerchant] = useState(item?.matchMerchant ?? '');
  const [active, setActive] = useState(item?.active ?? true);
  const [confirm, setConfirm] = useState(false);
  const [bad, setBad] = useState<string | null>(null);

  const done = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['recurring'] }), qc.invalidateQueries({ queryKey: ['cashflow'] })]);
    onClose();
  };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      item
        ? api(`/api/recurring-costs/${encodeURIComponent(item.id)}`, { method: 'PATCH', body })
        : api('/api/recurring-costs', { method: 'POST', body }),
    onSuccess: done,
  });
  const del = useMutation({
    mutationFn: () => api(`/api/recurring-costs/${encodeURIComponent(item!.id)}`, { method: 'DELETE' }),
    onSuccess: done,
  });

  const track = (s: DetectedStream) => {
    setName(s.description);
    setAmount(String(s.averageAmount));
    setDay(String(dayFrom(s)));
    setMerchant(s.description);
    setBad(null);
    document.getElementById('rc-name')?.focus();
  };

  const submit = () => {
    const amt = parseAmount(amount);
    const day = Number(dayOfMonth);
    if (!name.trim()) return setBad('Enter a name.');
    if (!Number.isFinite(amt) || amt <= 0) return setBad('Enter an amount above zero.');
    if (!Number.isInteger(day) || day < 1 || day > 31) return setBad('Day of month must be 1 to 31.');
    setBad(null);
    save.mutate({
      name: name.trim(), amount: Math.round(amt * 100) / 100, dayOfMonth: day, category,
      matchMerchant: merchant.trim() || null, ...(item ? { active } : {}),
    });
  };

  const field = (label: string, node: React.ReactNode) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="label">{label}</span>
      {node}
    </label>
  );

  return (
    <Sheet title={item ? 'Edit recurring cost' : 'Add recurring cost'} onClose={onClose}>
      {!item && detected.length > 0 && (
        <section aria-label="Detected" style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="label" style={{ marginBottom: 4 }}>Detected</span>
          <div style={{ maxHeight: 190, overflowY: 'auto' }}>
            {detected.map((s) => (
              <div key={s.streamId} className="row">
                <span className="row-mid">
                  <span className="row-title">{s.description}</span>
                  <span className="row-sub tnum">{FREQ[s.frequency] ?? 'Recurring'} · {money(s.averageAmount)}</span>
                </span>
                <button className="btn-ghost" style={{ color: 'var(--gold)' }} aria-label={`Track ${s.description}`} onClick={() => track(s)}>Track</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {field('Name', <input id="rc-name" className="field" data-autofocus={item ? undefined : ''} autoComplete="off" maxLength={80} placeholder="Netflix" value={name} onChange={(e) => setName(e.target.value)} />)}
      <div style={{ display: 'flex', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0 }}>
          <span className="label">Amount</span>
          <span style={{ position: 'relative' }}>
            <span aria-hidden="true" className="muted" style={{ position: 'absolute', left: 14, top: 0, height: 46, display: 'flex', alignItems: 'center' }}>$</span>
            <input className="field tnum" style={{ paddingLeft: 28 }} inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </span>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 130 }}>
          <span className="label">Day of month</span>
          <input className="field tnum" inputMode="numeric" autoComplete="off" placeholder="1–31" maxLength={2} value={dayOfMonth} onChange={(e) => setDay(e.target.value.replace(/\D/g, ''))} />
        </label>
      </div>
      {field('Category',
        <select className="field" value={category} onChange={(e) => setCategory(e.target.value)}>
          {!cats.data && <option value={category}>{item?.categoryLabel ?? 'Bills & utilities'}</option>}
          {cats.data?.filter((c) => !SKIP.has(c.key)).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>,
      )}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="label">Match merchant</span>
        <input className="field" autoComplete="off" maxLength={100} placeholder="Defaults to the name" value={merchant} onChange={(e) => setMerchant(e.target.value)} aria-describedby="rc-match-help" />
        <span id="rc-match-help" className="row-sub">A payment within 15% of the amount from this merchant marks the bill paid.</span>
      </label>
      {item && (
        <button className="switch-row" role="switch" aria-checked={active} onClick={() => setActive((a) => !a)}>
          <span style={{ flex: 1 }}>
            <span className="row-title" style={{ display: 'block' }}>Active</span>
            <span className="row-sub">Paused costs are left out of totals and the forecast</span>
          </span>
          <span className="switch" aria-hidden="true" />
        </button>
      )}

      {cats.isError && <ErrorBanner message="Couldn't load categories." onRetry={() => cats.refetch()} />}
      {bad && <ErrorBanner message={bad} />}
      {save.isError && <ErrorBanner message={errMsg(save.error)} />}
      {del.isError && <ErrorBanner message={errMsg(del.error)} />}
      <button className="btn-gold" disabled={save.isPending} onClick={submit}>{save.isPending ? 'Saving…' : item ? 'Save changes' : 'Add recurring cost'}</button>
      {item && (!confirm
        ? <button className="btn-ghost" style={{ color: 'var(--over-text)', borderColor: 'rgba(238,154,110,.45)' }} onClick={() => setConfirm(true)}>Delete</button>
        : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="row-sub" style={{ marginRight: 'auto' }}>Delete {item.name}?</span>
            <button className="btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn-ghost" style={{ color: 'var(--over-text)', borderColor: 'rgba(238,154,110,.45)' }} disabled={del.isPending} onClick={() => del.mutate()}>{del.isPending ? 'Deleting…' : 'Delete'}</button>
          </div>
        ))}
    </Sheet>
  );
}
