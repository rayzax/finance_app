import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../api';
import { fullDay, money } from '../format';
import { useCategories } from '../hooks';
import type { Tx } from '../types';
import { Sheet } from './Sheet';
import { ErrorBanner } from './bits';
import { TxAvatar } from './TxAvatar';

export function TransactionSheet({ tx, onClose }: { tx: Tx; onClose: () => void }) {
  const qc = useQueryClient();
  const cats = useCategories();
  const [category, setCategory] = useState(tx.category);
  const [apply, setApply] = useState(false);
  const save = useMutation({
    mutationFn: () => api<Tx>(`/api/transactions/${encodeURIComponent(tx.id)}`, { method: 'PATCH', body: { category, applyToMerchant: apply } }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['transactions'] }), qc.invalidateQueries({ queryKey: ['budgets'] }), qc.invalidateQueries({ queryKey: ['cashflow'] })]);
      onClose();
    },
  });
  const name = tx.merchantName || tx.name;
  const out = tx.amount > 0;
  const changed = category !== tx.category;
  const detail = (k: string, v: string) => (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span className="row-sub">{k}</span><span style={{ fontSize: 15 }}>{v}</span>
    </div>
  );

  return (
    <Sheet title="Transaction" onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <TxAvatar tx={tx} />
        <div style={{ minWidth: 0 }}>
          <div className="row-title" style={{ whiteSpace: 'normal' }}>{name}</div>
          {tx.pending && <span className="row-sub">Pending</span>}
        </div>
      </div>
      <div className={'serif tnum' + (tx.kind === 'income' ? ' pos' : '')} style={{ fontSize: 40, fontWeight: 600, lineHeight: 1 }}>
        {out ? '−' : '+'}{money(Math.abs(tx.amount))}
      </div>
      <div>
        {detail('Date', fullDay(tx.date))}
        {detail('Account', tx.accountName)}
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="label">Category{tx.userCategory ? ' · set by you' : ''}</span>
        <select className="field" value={category} onChange={(e) => setCategory(e.target.value)} disabled={cats.isPending}>
          {!cats.data && <option value={tx.category}>{tx.categoryLabel}</option>}
          {cats.data?.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      </label>
      <button className="switch-row" role="switch" aria-checked={apply} onClick={() => setApply((a) => !a)}>
        <span style={{ flex: 1 }}>
          <span className="row-title" style={{ display: 'block', whiteSpace: 'normal' }}>Apply to future transactions</span>
          <span className="row-sub">From {name}</span>
        </span>
        <span className="switch" aria-hidden="true" />
      </button>
      {cats.isError && <ErrorBanner message="Couldn't load categories." onRetry={() => cats.refetch()} />}
      {save.isError && <ErrorBanner message={errMsg(save.error)} />}
      <button className="btn-gold" disabled={save.isPending || (!changed && !apply)} onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
    </Sheet>
  );
}
