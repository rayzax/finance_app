import { useState } from 'react';
import { Link } from 'react-router-dom';
import { greeting, liability, money, signed, splitMoney, timeAgo, todayLong } from '../format';
import { useSummary, useSyncAll } from '../hooks';
import { Ico, Ridge } from '../icons';
import { usePlaid } from '../plaid';
import type { Range } from '../types';
import { ErrorBanner, Loading, Skeleton } from '../components/bits';
import { NetWorthChart } from '../components/NetWorthChart';
import { PullToRefresh } from '../components/PullToRefresh';
import { SettingsSheet } from '../components/SettingsSheet';

const RANGES: { k: Range; label: string }[] = [{ k: '1M', label: '1M' }, { k: '3M', label: '3M' }, { k: '1Y', label: '1Y' }, { k: 'ALL', label: 'All' }];
const LIAB = new Set(['credit', 'loans']);

export default function Home() {
  const [range, setRange] = useState<Range>('1M');
  const [settings, setSettings] = useState(false);
  const q = useSummary(range);
  const sync = useSyncAll();
  const plaid = usePlaid();
  const s = q.data;

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>{todayLong()}</span>
        <h1 className="serif" style={{ fontSize: 27, fontWeight: 600 }}>{greeting()}, Drew</h1>
      </div>
      <button className="avatar-btn" aria-label="Profile and settings" onClick={() => setSettings(true)}>DS</button>
    </div>
  );

  let body;
  if (q.isPending) {
    body = (
      <>
        <Loading />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Skeleton w={90} h={11} /><Skeleton w={240} h={48} r={10} /><Skeleton w={150} h={13} />
        </div>
        <Skeleton h={112} r={12} />
        <Skeleton h={50} r={14} />
        <Skeleton h={230} r={20} />
      </>
    );
  } else if (q.isError && !s) {
    body = <ErrorBanner message="Couldn't load your accounts." onRetry={() => q.refetch()} />;
  } else if (s && !s.hasAccounts) {
    body = (
      <section className="card" aria-label="Get started" style={{ padding: '36px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center', marginTop: 40 }}>
        <h2 className="serif" style={{ fontSize: 30, fontWeight: 600 }}>Link your first account</h2>
        <p className="muted" style={{ fontSize: 14, maxWidth: 280 }}>Connect a bank, card or brokerage to see your net worth, spending and forecast in one place.</p>
        <button className="btn-gold" style={{ marginTop: 8 }} disabled={plaid.busy} onClick={() => plaid.start()}>{plaid.busy ? 'Opening…' : 'Link an account'}</button>
      </section>
    );
  } else if (s) {
    const { sign, whole, cents } = splitMoney(s.netWorth);
    body = (
      <>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="label wide">Net worth</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }} aria-label={`Net worth ${money(s.netWorth)}`}>
            <span className="serif tnum" style={{ fontSize: 54, fontWeight: 500, lineHeight: 1, letterSpacing: '-0.01em' }}>{sign}{whole}</span>
            <span className="serif" style={{ fontSize: 26, color: 'var(--muted)' }}>{cents}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span className={s.delta < 0 ? 'neg' : 'pos'} style={{ fontWeight: 600 }}>{signed(s.delta)}</span>
            <span className="muted">{s.deltaLabel}</span>
          </div>
        </div>
        <NetWorthChart series={s.series} />
        <div className="seg" role="group" aria-label="Chart range">
          {RANGES.map((r) => <button key={r.k} aria-pressed={r.k === range} onClick={() => setRange(r.k)}>{r.label}</button>)}
        </div>
        <section className="card" aria-label="Accounts">
          <div className="card-head">
            <h2>Accounts</h2>
            <button className="textlink" disabled={plaid.busy} onClick={() => plaid.start()}>Link account</button>
          </div>
          {s.groups.map((g) => (
            <Link key={g.group} to={`/wealth?group=${g.group}`} className="row press">
              <span className="row-icon"><Ico name={g.group} /></span>
              <span className="row-mid"><span className="row-title">{g.label}</span><span className="row-sub">{g.subtitle}</span></span>
              <span className={'row-amt' + (LIAB.has(g.group) ? ' liab' : '')}>{LIAB.has(g.group) ? liability(g.total) : money(g.total)}</span>
            </Link>
          ))}
        </section>
        <p className="muted" style={{ fontSize: 12, textAlign: 'center' }}>
          {sync.isPending ? 'Syncing…' : `Updated ${timeAgo(s.lastSyncAt)}`}
        </p>
      </>
    );
  }

  return (
    <PullToRefresh onRefresh={() => sync.mutateAsync()}>
      <main className="screen home">
        <Ridge className="ridge" />
        {header}
        {plaid.error && <ErrorBanner message={plaid.error} />}
        {body}
      </main>
      {settings && <SettingsSheet lastSyncAt={s?.lastSyncAt ?? null} onClose={() => setSettings(false)} />}
    </PullToRefresh>
  );
}
