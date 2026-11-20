import { useEffect, useMemo, useRef, useState } from 'react';
import { money, monthShort } from '../format';
import { useSyncAll, useTransactions } from '../hooks';
import { Ico } from '../icons';
import type { Tx } from '../types';
import { ErrorBanner, Loading, Skeleton } from '../components/bits';
import { PullToRefresh } from '../components/PullToRefresh';
import { TransactionSheet } from '../components/TransactionSheet';
import { TxAvatar } from '../components/TxAvatar';

const FILTERS = [{ k: '', label: 'All' }, { k: 'spend', label: 'Spending' }, { k: 'income', label: 'Income' }, { k: 'transfer', label: 'Transfers' }];

export default function Activity() {
  const [kind, setKind] = useState('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Tx | null>(null);
  const sync = useSyncAll();
  const tx = useTransactions(kind, q);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 300);
    return () => window.clearTimeout(t);
  }, [text]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage, isError } = tx;
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting && hasNextPage && !isFetchingNextPage && !isError) fetchNextPage();
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, isError]);

  const pages = tx.data?.pages;
  const days = useMemo(() => {
    const out: { date: string; label: string; items: Tx[] }[] = [];
    for (const p of pages ?? []) for (const d of p.days) {
      const last = out[out.length - 1];
      if (last && last.date === d.date) last.items = [...last.items, ...d.items];
      else out.push({ ...d, items: [...d.items] });
    }
    return out;
  }, [pages]);
  const first = pages?.[0];

  return (
    <PullToRefresh onRefresh={() => sync.mutateAsync()}>
      <main className="screen">
        <div className="title-row">
          <h1 className="h1">Activity</h1>
          <a className="round-btn press" aria-label="Export transactions as CSV" href={`/api/transactions.csv?month=${first?.month ?? ''}`} download>
            <Ico name="export" />
          </a>
        </div>
        <div className="tiles">
          <div className="tile">
            <span className="label">Spent · {first ? monthShort(first.month) : '—'}</span>
            {first ? <span className="val tnum">{money(first.monthSpent)}</span> : <Skeleton w={110} h={26} />}
          </div>
          <div className="tile">
            <span className="label">Earned · {first ? monthShort(first.month) : '—'}</span>
            {first ? <span className="val tnum pos">{money(first.monthEarned)}</span> : <Skeleton w={110} h={26} />}
          </div>
        </div>
        <label className="search">
          <Ico name="search" />
          <span className="sr-only">Search transactions</span>
          <input type="search" placeholder="Search merchants, categories" value={text} onChange={(e) => setText(e.target.value)} enterKeyHint="search" autoComplete="off" />
        </label>
        <div className="chips" role="group" aria-label="Filter">
          {FILTERS.map((f) => <button key={f.k} className="chip" aria-pressed={f.k === kind} onClick={() => setKind(f.k)}>{f.label}</button>)}
        </div>

        {tx.isPending && (
          <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Loading />
            {Array.from({ length: 7 }, (_, i) => <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center', height: 56 }}><Skeleton w={38} h={38} r={19} /><div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}><Skeleton w="55%" h={14} /><Skeleton w="30%" h={11} /></div><Skeleton w={60} h={14} /></div>)}
          </div>
        )}
        {tx.isError && <ErrorBanner message="Couldn't load transactions." onRetry={() => tx.refetch()} />}
        {tx.isSuccess && days.length === 0 && <p className="muted" style={{ textAlign: 'center', padding: '24px 0', fontSize: 14 }}>{q || kind ? 'No matching transactions.' : 'No transactions yet.'}</p>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {days.map((g) => (
            <section key={g.date} style={{ display: 'flex', flexDirection: 'column' }}>
              <h2 style={{ margin: '0 0 4px', fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>{g.label}</h2>
              {g.items.map((t) => {
                const inc = t.kind === 'income';
                return (
                  <button key={t.id} onClick={() => setOpen(t)} className="press"
                    style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 56, padding: '8px 0', border: 0, borderBottom: '1px solid rgba(201,168,106,.09)', background: 'transparent', textAlign: 'left' }}>
                    <TxAvatar tx={t} />
                    <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span className="row-title">{t.merchantName || t.name}</span>
                      <span className="row-sub">
                        {t.categoryLabel}
                        {t.pending && <span style={{ marginLeft: 8, padding: '1px 7px', border: '1px solid var(--line)', borderRadius: 8, fontSize: 11, color: 'var(--muted-2)' }}>Pending</span>}
                      </span>
                    </span>
                    <span className={'row-amt' + (inc ? ' pos' : '')}>{t.amount > 0 ? '−' : '+'}{money(Math.abs(t.amount))}</span>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
        <div ref={sentinel} style={{ height: 1 }} />
        {isFetchingNextPage && <Skeleton h={56} r={12} />}
        {tx.isFetchNextPageError && <ErrorBanner message="Couldn't load more." onRetry={() => fetchNextPage()} />}
      </main>
      {open && <TransactionSheet tx={open} onClose={() => setOpen(null)} />}
    </PullToRefresh>
  );
}
