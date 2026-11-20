import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../api';
import { useCategories } from '../hooks';
import type { Budgets } from '../types';
import { Sheet } from './Sheet';
import { ErrorBanner } from './bits';

const SKIP = new Set(['income', 'transfer']);

export function BudgetEditSheet({ budgets, onClose }: { budgets: Budgets; onClose: () => void }) {
  const qc = useQueryClient();
  const cats = useCategories();
  const current = new Map(budgets.categories.map((c) => [c.key, c.limit]));
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(budgets.categories.filter((c) => c.limit && c.limit > 0).map((c) => [c.key, String(c.limit)])),
  );
  const [bad, setBad] = useState<string | null>(null);

  // every spend category, plus any category the budget response already knows
  const list = new Map<string, string>();
  cats.data?.filter((c) => !SKIP.has(c.key)).forEach((c) => list.set(c.key, c.label));
  budgets.categories.forEach((c) => { if (!list.has(c.key)) list.set(c.key, c.label); });

  const save = useMutation({
    mutationFn: (limits: Record<string, number>) => api('/api/budgets', { method: 'PUT', body: { limits } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['budgets'] });
      onClose();
    },
  });

  const submit = () => {
    const limits: Record<string, number> = {};
    for (const [key, raw] of Object.entries(vals)) {
      const t = raw.replace(/[$,\s]/g, '');
      if (!t) continue;
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0) { setBad(list.get(key) ?? key); return; }
      if (n > 0) limits[key] = Math.round(n * 100) / 100;
    }
    setBad(null);
    save.mutate(limits);
  };

  return (
    <Sheet title="Monthly limits" onClose={onClose}>
      <p className="row-sub" style={{ fontSize: 13 }}>These apply every month. Leave a category empty for no limit.</p>
      {cats.isError && current.size === 0 && <ErrorBanner message="Couldn't load categories." onRetry={() => cats.refetch()} />}
      <div>
        {[...list].map(([key, label]) => (
          <label key={key} className="row" style={{ justifyContent: 'space-between' }}>
            <span className="row-title">{label}</span>
            <span style={{ position: 'relative', width: 128 }}>
              <span aria-hidden="true" className="muted" style={{ position: 'absolute', left: 14, top: 0, height: 46, display: 'flex', alignItems: 'center' }}>$</span>
              <input
                className="field tnum"
                style={{ paddingLeft: 28, textAlign: 'right' }}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                aria-label={`${label} monthly limit in dollars`}
                value={vals[key] ?? ''}
                onChange={(e) => setVals((v) => ({ ...v, [key]: e.target.value }))}
              />
            </span>
          </label>
        ))}
      </div>
      {bad && <ErrorBanner message={`Enter a valid amount for ${bad}.`} />}
      {save.isError && <ErrorBanner message={errMsg(save.error)} />}
      <button className="btn-gold" disabled={save.isPending} onClick={submit}>{save.isPending ? 'Saving…' : 'Save limits'}</button>
    </Sheet>
  );
}
