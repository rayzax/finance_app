import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, errMsg } from '../api';
import { usePeople } from '../hooks';
import type { Person, Role } from '../types';
import { Sheet } from './Sheet';
import { ErrorBanner, Loading, Skeleton } from './bits';
import { CopyButton, generateTempPassword } from './authBits';

type Action = 'reset-password' | 'reset-mfa' | 'toggle-disabled' | 'toggle-role' | 'delete';
type View =
  | { k: 'list' }
  | { k: 'add' }
  | { k: 'person'; id: string }
  | { k: 'confirm'; id: string; action: Action }
  | { k: 'password'; name: string; username: string; password: string; created: boolean };

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const roleLabel = (r: Role) => (r === 'admin' ? 'Admin' : 'Member');
const ago = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Never');

function initialsOf(name: string) {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return ((w.length > 1 ? w[0][0] + w[w.length - 1][0] : w[0]?.slice(0, 2)) ?? '?').toUpperCase();
}

export function PeopleSheet({ meId, onClose }: { meId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = usePeople();
  const [view, setView] = useState<View>({ k: 'list' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const people = q.data?.users ?? [];
  const person = (id: string) => people.find((p) => p.id === id);
  const refresh = () => qc.invalidateQueries({ queryKey: ['people'] });

  const titles: Record<View['k'], string> = { list: 'People', add: 'Add person', person: 'Person', confirm: 'Are you sure?', password: 'Temporary password' };
  const go = (v: View) => { setErr(null); setView(v); };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (ex) { setErr(errMsg(ex)); } finally { setBusy(false); }
  };

  // ---- list ----
  const list = (
    <>
      {q.isPending && <><Loading /><Skeleton h={56} r={12} /><Skeleton h={56} r={12} /></>}
      {q.isError && <ErrorBanner message="Couldn't load people." onRetry={() => q.refetch()} />}
      <div>
        {people.map((p) => (
          <button key={p.id} className="row" style={{ background: 'transparent', border: 0, borderTop: '1px solid var(--line-soft)', textAlign: 'left' }}
            onClick={() => go({ k: 'person', id: p.id })}>
            <span className="initials-tile" aria-hidden="true">{initialsOf(p.displayName)}</span>
            <span className="row-mid">
              <span className="row-title">{p.displayName}{p.id === meId ? ' (you)' : ''}</span>
              <span className="row-sub">@{p.username} · {roleLabel(p.role)}</span>
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
              <span className={'tag ' + (p.totpEnabled ? 'soft' : 'gold')}>{p.totpEnabled ? 'MFA on' : 'MFA pending'}</span>
              {p.disabled && <span className="tag neg">Disabled</span>}
            </span>
          </button>
        ))}
      </div>
      <button className="btn-gold" onClick={() => go({ k: 'add' })}>Add person</button>
    </>
  );

  // ---- add ----
  const addForm = () => {
    const u = username.trim().toLowerCase();
    const bad = u && !USERNAME_RE.test(u) ? 'Username: 3 to 32 characters, a-z 0-9 . _ -' : null;
    const submit = (e: React.FormEvent) => {
      e.preventDefault();
      if (busy || !USERNAME_RE.test(u) || !name.trim()) return;
      const password = generateTempPassword();
      void run(async () => {
        try {
          await api('/api/users', { method: 'POST', body: { username: u, displayName: name.trim(), role, temporaryPassword: password } });
        } catch (ex) {
          throw ex instanceof ApiError && ex.status === 409 ? new Error('That username is taken.') : ex;
        }
        await refresh();
        setUsername(''); setName(''); setRole('member');
        go({ k: 'password', name: name.trim(), username: u, password, created: true });
      });
    };
    return (
      <form onSubmit={submit} className="stack">
        <label className="stack" style={{ gap: 8 }}>
          <span className="sr-only">Username</span>
          <input className="field" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Username" value={username}
            onChange={(e) => setUsername(e.target.value)} data-autofocus aria-invalid={!!bad} aria-describedby={bad ? 'add-bad' : undefined} />
        </label>
        {bad && <p id="add-bad" style={{ color: 'var(--over-text)', fontSize: 13 }}>{bad}</p>}
        <label className="stack" style={{ gap: 8 }}>
          <span className="sr-only">Display name</span>
          <input className="field" autoComplete="off" maxLength={60} placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div>
          <span className="label" id="role-label">Role</span>
          <div className="seg" role="group" aria-labelledby="role-label" style={{ marginTop: 8 }}>
            {(['member', 'admin'] as Role[]).map((r) => (
              <button type="button" key={r} aria-pressed={role === r} onClick={() => setRole(r)}>{roleLabel(r)}</button>
            ))}
          </div>
        </div>
        <p className="hint">A temporary password is generated for you. They will set up two-step sign-in and choose their own password at first sign-in.</p>
        {err && <ErrorBanner message={err} />}
        <button className="btn-gold" type="submit" disabled={busy || !USERNAME_RE.test(u) || !name.trim()}>{busy ? 'Creating…' : 'Create'}</button>
        <button type="button" className="link-btn" style={{ color: 'var(--muted-2)' }} onClick={() => go({ k: 'list' })}>Cancel</button>
      </form>
    );
  };

  // ---- one person ----
  const personView = (p: Person) => {
    const self = p.id === meId;
    const item = (action: Action, title: string, sub: string, danger = false) => (
      <button key={action} className="row" style={{ background: 'transparent', border: 0, borderTop: '1px solid var(--line-soft)', textAlign: 'left' }}
        onClick={() => go({ k: 'confirm', id: p.id, action })}>
        <span className="row-mid">
          <span className="row-title" style={danger ? { color: 'var(--over-text)' } : undefined}>{title}</span>
          <span className="row-sub">{sub}</span>
        </span>
      </button>
    );
    return (
      <>
        <div className="row" style={{ borderTop: 0 }}>
          <span className="initials-tile" aria-hidden="true">{initialsOf(p.displayName)}</span>
          <span className="row-mid">
            <span className="row-title">{p.displayName}</span>
            <span className="row-sub">@{p.username} · {roleLabel(p.role)} · Last sign-in {ago(p.lastLoginAt)}</span>
          </span>
        </div>
        <div>
          {item('reset-password', 'Reset password', 'Issue a new temporary password')}
          {item('reset-mfa', 'Reset two-step sign-in', 'They set it up again at next sign-in')}
          {!self && item('toggle-disabled', p.disabled ? 'Enable account' : 'Disable account', p.disabled ? 'Allow them to sign in again' : 'Sign them out and block sign-in')}
          {!self && item('toggle-role', p.role === 'admin' ? 'Make member' : 'Make admin', p.role === 'admin' ? 'Remove access to this screen' : 'Can manage people')}
          {!self && item('delete', 'Delete', 'Remove the account for good', true)}
        </div>
        <button className="link-btn" onClick={() => go({ k: 'list' })}>Back</button>
      </>
    );
  };

  // ---- confirm ----
  const confirmView = (p: Person, action: Action) => {
    const copy: Record<Action, { text: string; label: string; danger?: boolean }> = {
      'reset-password': { text: `Sign ${p.displayName} out everywhere and issue a new temporary password. They must change it at next sign-in.`, label: 'Reset password' },
      'reset-mfa': { text: `Remove ${p.displayName}'s authenticator and recovery codes and sign them out. They set up two-step sign-in again at next sign-in.`, label: 'Reset two-step', danger: true },
      'toggle-disabled': p.disabled
        ? { text: `${p.displayName} will be able to sign in again.`, label: 'Enable account' }
        : { text: `${p.displayName} is signed out now and cannot sign in until you enable the account.`, label: 'Disable account', danger: true },
      'toggle-role': p.role === 'admin'
        ? { text: `${p.displayName} will no longer be able to manage people.`, label: 'Make member', danger: true }
        : { text: `${p.displayName} will be able to add, change and remove people.`, label: 'Make admin' },
      delete: { text: `Delete ${p.displayName} (@${p.username}) permanently. Shared finance data is not affected.`, label: 'Delete', danger: true },
    };
    const c = copy[action];
    const confirm = () => run(async () => {
      if (action === 'reset-password') {
        const password = generateTempPassword();
        await api(`/api/users/${p.id}/reset-password`, { method: 'POST', body: { temporaryPassword: password } });
        await refresh();
        go({ k: 'password', name: p.displayName, username: p.username, password, created: false });
        return;
      }
      if (action === 'reset-mfa') await api(`/api/users/${p.id}/reset-mfa`, { method: 'POST', body: {} });
      if (action === 'toggle-disabled') await api(`/api/users/${p.id}`, { method: 'PATCH', body: { disabled: !p.disabled } });
      if (action === 'toggle-role') await api(`/api/users/${p.id}`, { method: 'PATCH', body: { role: p.role === 'admin' ? 'member' : 'admin' } });
      if (action === 'delete') await api(`/api/users/${p.id}`, { method: 'DELETE' });
      await refresh();
      go(action === 'delete' ? { k: 'list' } : { k: 'person', id: p.id });
    });
    return (
      <>
        <p style={{ fontSize: 15, lineHeight: 1.45 }}>{c.text}</p>
        {err && <ErrorBanner message={err} />}
        <button className={c.danger ? 'btn-danger' : 'btn-gold'} disabled={busy} onClick={confirm}>{busy ? 'Working…' : c.label}</button>
        <button className="btn-ghost" onClick={() => go({ k: 'person', id: p.id })}>Cancel</button>
      </>
    );
  };

  let body;
  if (view.k === 'list') body = list;
  else if (view.k === 'add') body = addForm();
  else if (view.k === 'password') {
    body = (
      <>
        <p className="hint">{view.created ? `${view.name} can sign in as @${view.username} with this password.` : `New temporary password for ${view.name}.`} It is shown only once. They will be asked to change it.</p>
        <div className="secret-box">
          <code className="mono" style={{ fontSize: 16, letterSpacing: '.04em' }} aria-label="Temporary password">{view.password}</code>
          <CopyButton text={view.password} className="btn-ghost" />
        </div>
        <button className="btn-gold" onClick={() => go({ k: 'list' })}>Done</button>
      </>
    );
  } else {
    const p = person(view.id);
    body = !p ? list : view.k === 'person' ? personView(p) : confirmView(p, view.action);
  }

  return <Sheet title={titles[view.k]} onClose={onClose}>{body}</Sheet>;
}
