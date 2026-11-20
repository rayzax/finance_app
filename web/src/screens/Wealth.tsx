import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../api';
import { liability, money, splitMoney, timeAgo } from '../format';
import { useAccounts, useSummary } from '../hooks';
import { usePlaid } from '../plaid';
import type { AccountItem } from '../types';
import { ErrorBanner, Loading, Skeleton } from '../components/bits';

const LIAB = new Set(['credit', 'loans']);

function Connection({ item, onReconnect, busy }: { item: AccountItem; onReconnect: (id: string) => void; busy: boolean }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const del = useMutation({
    mutationFn: () => api(`/api/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const needs = item.status === 'login_required' || item.newAccountsAvailable;
  const sub =
    item.status === 'login_required' ? <span className="liab">Needs login</span>
    : item.status === 'error' ? <span className="neg">{item.error || 'Error'}</span>
    : item.newAccountsAvailable ? <span className="liab">New accounts available</span>
    : <>Synced {timeAgo(item.lastSyncAt)}</>;
  return (
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <span className="row-icon">{item.institutionName.charAt(0).toUpperCase()}</span>
      <span className="row-mid"><span className="row-title">{item.institutionName}</span><span className="row-sub">{sub}</span></span>
      {needs && <button className="btn-sm-gold" disabled={busy} onClick={() => onReconnect(item.id)}>Reconnect</button>}
      {!confirm
        ? <button className="textlink" aria-label={`Remove ${item.institutionName}`} onClick={() => setConfirm(true)} style={{ color: 'var(--muted-2)' }}>Remove</button>
        : (
          <div style={{ display: 'flex', gap: 8, width: '100%', justifyContent: 'flex-end', alignItems: 'center' }}>
            <span className="row-sub" style={{ marginRight: 'auto' }}>Remove this connection and its data?</span>
            <button className="btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn-ghost" style={{ color: 'var(--over-text)', borderColor: 'rgba(238,154,110,.45)' }} disabled={del.isPending} onClick={() => del.mutate()}>{del.isPending ? 'Removing…' : 'Remove'}</button>
          </div>
        )}
      {del.isError && <div style={{ width: '100%' }}><ErrorBanner message={errMsg(del.error)} /></div>}
    </div>
  );
}

export default function Wealth() {
  const [sp, setSp] = useSearchParams();
  const group = sp.get('group');
  const loc = useLocation();
  const acc = useAccounts();
  const sum = useSummary('1M');
  const plaid = usePlaid();

  useEffect(() => {
    if (loc.hash === '#connections' && acc.data) document.getElementById('connections')?.scrollIntoView();
  }, [loc.hash, acc.data]);

  const s = sum.data;
  const groups = acc.data?.groups.filter((g) => !group || g.group === group) ?? [];
  const nw = s ? splitMoney(s.netWorth) : null;

  return (
    <main className="screen">
      <h1 className="h1">Wealth</h1>
      {plaid.error && <ErrorBanner message={plaid.error} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="label wide">Net worth</span>
        {nw ? (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
            <span className="serif tnum" style={{ fontSize: 44, fontWeight: 500, lineHeight: 1 }}>{nw.sign}{nw.whole}</span>
            <span className="serif" style={{ fontSize: 22, color: 'var(--muted)' }}>{nw.cents}</span>
          </div>
        ) : <Skeleton w={200} h={44} r={10} />}
      </div>
      <div className="tiles">
        <div className="tile"><span className="label">Assets</span>{s ? <span className="val tnum">{money(s.assets)}</span> : <Skeleton w={100} h={26} />}</div>
        <div className="tile"><span className="label">Liabilities</span>{s ? <span className="val tnum liab">{liability(s.liabilities)}</span> : <Skeleton w={100} h={26} />}</div>
      </div>

      {acc.isPending && (<><Loading /><Skeleton h={180} r={20} /><Skeleton h={140} r={20} /></>)}
      {acc.isError && <ErrorBanner message="Couldn't load accounts." onRetry={() => acc.refetch()} />}

      {group && (
        <div className="chips"><button className="chip" aria-pressed="true" onClick={() => setSp({})}>Showing {acc.data?.groups.find((g) => g.group === group)?.label ?? group} · Show all</button></div>
      )}

      {acc.data && acc.data.groups.length === 0 && (
        <section className="card" style={{ padding: '28px 20px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
          <h2 className="serif" style={{ fontSize: 26, fontWeight: 600 }}>No accounts yet</h2>
          <p className="muted" style={{ fontSize: 14 }}>Link an account to see your balances here.</p>
        </section>
      )}

      {groups.map((g) => {
        const isL = LIAB.has(g.group);
        return (
          <section key={g.group} className="card" aria-label={g.label}>
            <div className="card-head">
              <h2>{g.label}</h2>
              <span className={'row-amt' + (isL ? ' liab' : '')}>{isL ? liability(g.total) : money(g.total)}</span>
            </div>
            {g.accounts.map((a) => {
              const bal = a.current ?? 0;
              const util = g.group === 'credit' && a.limit && a.limit > 0 ? Math.min(1, Math.max(0, bal) / a.limit) : null;
              return (
                <div key={a.id} className="row" style={{ alignItems: 'center' }}>
                  <span className="row-icon" aria-hidden="true">{a.institutionName.charAt(0).toUpperCase()}</span>
                  <span className="row-mid">
                    <span className="row-title">{a.name}</span>
                    <span className="row-sub">{a.institutionName}{a.mask ? ` ··${a.mask}` : ''}</span>
                    {util !== null && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                        <span className="bar" style={{ flex: 1 }} role="img" aria-label={`${Math.round(util * 100)} percent utilization`}><i className={util > 0.3 ? 'over' : ''} style={{ width: `${util * 100}%` }} /></span>
                        <span className="row-sub tnum">{Math.round(util * 100)}%</span>
                      </span>
                    )}
                  </span>
                  <span className={'row-amt' + (isL ? ' liab' : '')}>{a.current === null ? '—' : isL ? liability(bal) : money(bal)}</span>
                </div>
              );
            })}
          </section>
        );
      })}

      {acc.data && (
        <section id="connections" className="card" aria-label="Connections" style={{ scrollMarginTop: 56 }}>
          <div className="card-head"><h2>Connections</h2></div>
          {acc.data.items.length === 0 && <p className="muted" style={{ fontSize: 14, padding: '4px 0 14px' }}>No linked institutions.</p>}
          {acc.data.items.map((it) => <Connection key={it.id} item={it} busy={plaid.busy} onReconnect={(id) => plaid.start(id)} />)}
        </section>
      )}

      <button className="btn-gold" disabled={plaid.busy} onClick={() => plaid.start()}>{plaid.busy ? 'Opening…' : 'Link an account'}</button>
    </main>
  );
}
