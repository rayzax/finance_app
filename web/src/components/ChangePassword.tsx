import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { Ridge } from '../icons';
import { Sheet } from './Sheet';

const MIN = 12;

/** Shared form. `forced` shows the first-sign-in copy and adds a sign-out escape. */
function ChangePasswordForm({ forced, onDone }: { forced?: boolean; onDone: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const invalid = !cur ? 'Enter your current password.'
    : pw.length < MIN ? `Use at least ${MIN} characters.`
    : new TextEncoder().encode(pw).length > 72 ? 'Use at most 72 bytes.'
    : pw !== again ? 'The new passwords do not match.'
    : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (invalid) { setErr(invalid); return; }
    setBusy(true);
    setErr(null);
    try {
      await api('/api/auth/password', { method: 'POST', body: { currentPassword: cur, newPassword: pw }, noRedirect: true });
      await qc.invalidateQueries({ queryKey: ['me'] });
      onDone();
    } catch (ex) {
      const s = ex instanceof ApiError ? ex.status : 0;
      setErr(s === 429 ? 'Too many attempts. Try again in a few minutes.' : ex instanceof ApiError && s < 500 ? ex.message : 'Could not change the password. Try again.');
      setCur('');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* leave anyway */ }
    qc.clear();
    nav('/login', { replace: true });
  };

  return (
    <form onSubmit={submit} className="stack">
      <p className="hint">{forced ? 'Choose a password only you know before you continue.' : 'Other devices will be signed out.'} At least {MIN} characters.</p>
      <label className="stack" style={{ gap: 8 }}>
        <span className="sr-only">{forced ? 'Temporary password' : 'Current password'}</span>
        <input className="field" type="password" autoComplete="current-password" placeholder={forced ? 'Temporary password' : 'Current password'}
          value={cur} onChange={(e) => setCur(e.target.value)} data-autofocus aria-invalid={!!err} aria-describedby={err ? 'pw-err' : undefined} />
      </label>
      <label className="stack" style={{ gap: 8 }}>
        <span className="sr-only">New password</span>
        <input className="field" type="password" autoComplete="new-password" placeholder="New password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <label className="stack" style={{ gap: 8 }}>
        <span className="sr-only">Repeat new password</span>
        <input className="field" type="password" autoComplete="new-password" placeholder="Repeat new password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      {err && <p id="pw-err" role="alert" style={{ color: 'var(--over-text)', fontSize: 13 }}>{err}</p>}
      <button className="btn-gold" type="submit" disabled={busy || !cur || !pw || !again}>{busy ? 'Saving…' : 'Change password'}</button>
      {forced && <button type="button" className="link-btn" style={{ color: 'var(--muted-2)' }} onClick={logout}>Sign out</button>}
    </form>
  );
}

/** Full screen, shown before the app while mustChangePassword is set. */
export function ChangePasswordScreen() {
  return (
    <main className="screen" style={{ minHeight: '100dvh', justifyContent: 'center', gap: 28 }}>
      <Ridge className="ridge" />
      <h1 className="serif" style={{ fontSize: 34, fontWeight: 600, textAlign: 'center', lineHeight: 1.05 }}>New password</h1>
      <ChangePasswordForm forced onDone={() => undefined} />
    </main>
  );
}

export function ChangePasswordSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Change password" onClose={onClose}>
      <ChangePasswordForm onDone={onClose} />
    </Sheet>
  );
}
