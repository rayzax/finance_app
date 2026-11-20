import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { Ridge } from '../icons';

export default function Login() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ authenticated: boolean }>('/api/auth/me', { noRedirect: true }), retry: false });
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (me.data?.authenticated) return <Navigate to="/" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api('/api/auth/login', { method: 'POST', body: { password: pw }, noRedirect: true });
      qc.setQueryData(['me'], { authenticated: true });
      nav('/', { replace: true });
    } catch (ex) {
      const s = ex instanceof ApiError ? ex.status : 0;
      setErr(s === 429 ? 'Too many attempts. Try again in a few minutes.' : s === 401 ? 'Incorrect password.' : 'Could not sign in. Check your connection and try again.');
      setPw('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="screen" style={{ minHeight: '100dvh', justifyContent: 'center', gap: 28 }}>
      <Ridge className="ridge" />
      <h1 className="serif" style={{ fontSize: 44, fontWeight: 600, textAlign: 'center', lineHeight: 1 }}>Reserve</h1>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="sr-only">Password</span>
          <input className="field" type="password" autoComplete="current-password" placeholder="Password" value={pw}
            onChange={(e) => setPw(e.target.value)} autoFocus aria-invalid={!!err} aria-describedby={err ? 'login-err' : undefined} />
        </label>
        {err && <p id="login-err" role="alert" style={{ color: 'var(--over-text)', fontSize: 13 }}>{err}</p>}
        <button className="btn-gold" type="submit" disabled={busy || !pw}>{busy ? 'Unlocking…' : 'Unlock'}</button>
      </form>
    </main>
  );
}
