import { useState } from 'react';
import { api, ApiError } from '../api';
import { Sheet } from './Sheet';
import { RecoveryCodesView } from './authBits';

export function RecoveryCodesSheet({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || code.length !== 6) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ recoveryCodes: string[] }>('/api/auth/recovery-codes', { method: 'POST', body: { code }, noRedirect: true });
      setCodes(r.recoveryCodes);
      setCode('');
    } catch (ex) {
      const s = ex instanceof ApiError ? ex.status : 0;
      setErr(s === 429 ? 'Too many attempts. Try again in a few minutes.' : s === 401 ? 'That code did not work.' : 'Something went wrong. Try again.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Recovery codes" onClose={onClose}>
      {codes ? (
        <>
          <p className="hint">Your old codes no longer work. Save these now; they are shown only once.</p>
          <RecoveryCodesView codes={codes} />
          <button className="btn-gold" onClick={onClose}>I&apos;ve saved these</button>
        </>
      ) : (
        <form onSubmit={submit} className="stack">
          <p className="hint">Generate ten new single-use codes. This replaces your current ones. Enter a code from your authenticator app to confirm.</p>
          <label className="stack" style={{ gap: 8 }}>
            <span className="sr-only">Authentication code</span>
            <input className="field code-field mono" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={6}
              placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} data-autofocus
              aria-invalid={!!err} aria-describedby={err ? 'rc-err' : undefined} />
          </label>
          {err && <p id="rc-err" role="alert" style={{ color: 'var(--over-text)', fontSize: 13 }}>{err}</p>}
          <button className="btn-gold" type="submit" disabled={busy || code.length !== 6}>{busy ? 'Generating…' : 'Generate new codes'}</button>
        </form>
      )}
    </Sheet>
  );
}
