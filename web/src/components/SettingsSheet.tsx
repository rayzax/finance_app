import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../api';
import { timeAgo } from '../format';
import { useMe, useSyncAll } from '../hooks';
import { Sheet } from './Sheet';
import { ErrorBanner } from './bits';
import { ChangePasswordSheet } from './ChangePassword';
import { PeopleSheet } from './PeopleSheet';
import { RecoveryCodesSheet } from './RecoveryCodesSheet';
import { NameSheet } from './NameSheet';

export function SettingsSheet({ lastSyncAt, onClose }: { lastSyncAt: string | null; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const sync = useSyncAll();
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [panel, setPanel] = useState<'password' | 'codes' | 'people' | 'name' | null>(null);
  const me = useMe().data?.user;

  const logout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* leave anyway */
    }
    qc.clear();
    nav('/login', { replace: true });
  };

  const seed = async () => {
    setSeeding(true);
    setErr(null);
    try {
      await api('/api/dev/seed', { method: 'POST' });
      await qc.invalidateQueries();
      setNote('Sandbox data seeded');
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSeeding(false);
    }
  };

  const rowBtn = { background: 'transparent', border: 0, borderTop: '1px solid var(--line-soft)' } as const;

  if (panel === 'password') return <ChangePasswordSheet onClose={onClose} />;
  if (panel === 'name' && me) return <NameSheet current={me.displayName} onClose={onClose} />;
  if (panel === 'codes') return <RecoveryCodesSheet onClose={onClose} />;
  if (panel === 'people' && me) return <PeopleSheet meId={me.id} onClose={onClose} />;

  return (
    <Sheet title="Settings" onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <div>
        <button className="row" style={rowBtn} disabled={sync.isPending}
          onClick={() => sync.mutate(undefined, { onSuccess: (r) => setNote(r.skipped ? 'Already synced a moment ago' : 'Synced'), onError: (e) => setErr(errMsg(e)) })}>
          <span className="row-mid">
            <span className="row-title">{sync.isPending ? 'Syncing…' : 'Sync now'}</span>
            <span className="row-sub">{note ?? `Last synced ${timeAgo(lastSyncAt)}`}</span>
          </span>
        </button>
        <button className="row" style={rowBtn} onClick={() => { onClose(); nav('/wealth#connections'); }}>
          <span className="row-mid"><span className="row-title">Connections</span><span className="row-sub">Linked institutions</span></span>
        </button>
        {me && (
          <div className="row" role="group" aria-label="Signed in as">
            <span className="row-mid"><span className="row-title">{me.displayName}</span><span className="row-sub">@{me.username} · {me.role === 'admin' ? 'Admin' : 'Member'}</span></span>
          </div>
        )}
        <button className="row" style={rowBtn} onClick={() => setPanel('name')}>
          <span className="row-mid"><span className="row-title">Your name</span><span className="row-sub">{me?.displayName ?? ''}</span></span>
        </button>
        <button className="row" style={rowBtn} onClick={() => setPanel('password')}>
          <span className="row-mid"><span className="row-title">Change password</span><span className="row-sub">Signs out your other devices</span></span>
        </button>
        <button className="row" style={rowBtn} onClick={() => setPanel('codes')}>
          <span className="row-mid"><span className="row-title">Recovery codes</span><span className="row-sub">Generate a new set</span></span>
        </button>
        {me?.role === 'admin' && (
          <button className="row" style={rowBtn} onClick={() => setPanel('people')}>
            <span className="row-mid"><span className="row-title">People</span><span className="row-sub">Add and manage who can sign in</span></span>
          </button>
        )}
        <div className="row" role="group" aria-label="Appearance">
          <span className="row-mid"><span className="row-title">Appearance</span></span>
          <span className="row-sub">Alpine</span>
        </div>
        {import.meta.env.DEV && (
          <button className="row" style={rowBtn} disabled={seeding} onClick={seed}>
            <span className="row-mid"><span className="row-title">{seeding ? 'Seeding…' : 'Seed sandbox data'}</span><span className="row-sub">Development only</span></span>
          </button>
        )}
        <button className="row" style={rowBtn} onClick={logout}>
          <span className="row-mid"><span className="row-title" style={{ color: 'var(--over-text)' }}>Log out</span></span>
        </button>
      </div>
    </Sheet>
  );
}
