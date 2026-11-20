import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { Ridge } from '../icons';
import type { Me } from '../types';
import { CopyButton, RecoveryCodesView } from '../components/authBits';

type Step = 'password' | 'mfa' | 'enroll' | 'codes';
interface Setup { otpauthUrl: string; secret: string; qrSvg: string }

const expired = (m: string) => /session expired/i.test(m);

export default function Login() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/auth/me', { noRedirect: true }), retry: false });
  const [step, setStep] = useState<Step>('password');
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Only bounce an already signed-in visitor from the first step; mid-flow the session cookie may already exist.
  if (step === 'password' && me.data?.authenticated) return <Navigate to="/" replace />;

  const backToPassword = (message: string | null) => {
    setStep('password'); setPw(''); setCode(''); setSetup(null); setRecovery(false); setErr(message);
  };
  const fail = (ex: unknown, fallback: string) => {
    if (ex instanceof ApiError && ex.status === 401 && expired(ex.message)) return backToPassword('Your sign-in timed out. Start again.');
    const s = ex instanceof ApiError ? ex.status : 0;
    setErr(s === 429 ? 'Too many attempts. Try again in a few minutes.' : s === 401 ? fallback : 'Could not reach the server. Check your connection and try again.');
    setCode('');
  };

  const loadSetup = async () => {
    setBusy(true);
    setErr(null);
    try {
      setSetup(await api<Setup>('/api/auth/mfa/setup', { method: 'POST', body: {}, noRedirect: true }));
    } catch (ex) {
      fail(ex, 'Could not start setup.');
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !pw || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ next: 'mfa' | 'enroll' }>('/api/auth/login', { method: 'POST', body: { username: username.trim(), password: pw }, noRedirect: true });
      setPw('');
      setCode('');
      setStep(r.next);
      if (r.next === 'enroll') await loadSetup();
    } catch (ex) {
      const s = ex instanceof ApiError ? ex.status : 0;
      setErr(s === 429 ? 'Too many attempts. Try again in a few minutes.' : s === 401 ? 'Invalid username or password.' : 'Could not sign in. Check your connection and try again.');
      setPw('');
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
    nav('/', { replace: true });
  };

  const submitMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api('/api/auth/mfa', { method: 'POST', body: { code: code.trim() }, noRedirect: true });
      await finish();
    } catch (ex) {
      fail(ex, recovery ? 'That recovery code did not work.' : 'That code did not work. Try the next one.');
    } finally {
      setBusy(false);
    }
  };

  const submitEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || code.length !== 6) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ recoveryCodes: string[] }>('/api/auth/mfa/enable', { method: 'POST', body: { code }, noRedirect: true });
      setCodes(r.recoveryCodes);
      setCode('');
      setStep('codes');
    } catch (ex) {
      fail(ex, 'That code did not work. Check the time on your phone and try the next one.');
    } finally {
      setBusy(false);
    }
  };

  const errEl = err && <p id="login-err" role="alert" style={{ color: 'var(--over-text)', fontSize: 13 }}>{err}</p>;
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);

  return (
    <main className="screen" style={{ minHeight: '100dvh', justifyContent: 'center', gap: 28 }}>
      <Ridge className="ridge" />
      <h1 className="serif" style={{ fontSize: 44, fontWeight: 600, textAlign: 'center', lineHeight: 1 }}>Reserve</h1>

      {step === 'password' && (
        <form onSubmit={submitPassword} className="stack" style={{ gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="sr-only">Username</span>
            <input className="field" type="text" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus aria-invalid={!!err} aria-describedby={err ? 'login-err' : undefined} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="sr-only">Password</span>
            <input className="field" type="password" name="password" autoComplete="current-password" placeholder="Password" value={pw}
              onChange={(e) => setPw(e.target.value)} aria-invalid={!!err} aria-describedby={err ? 'login-err' : undefined} />
          </label>
          {errEl}
          <button className="btn-gold" type="submit" disabled={busy || !username.trim() || !pw}>{busy ? 'Unlocking…' : 'Unlock'}</button>
        </form>
      )}

      {step === 'mfa' && (
        <form onSubmit={submitMfa} className="stack">
          <p className="hint" style={{ textAlign: 'center' }}>
            {recovery ? 'Enter one of your recovery codes. Each works once.' : 'Enter the 6-digit code from your authenticator app.'}
          </p>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="sr-only">{recovery ? 'Recovery code' : 'Authentication code'}</span>
            {recovery ? (
              <input key="rc" className="field code-field recovery mono" type="text" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                placeholder="xxxx-xxxx" maxLength={9} value={code} onChange={(e) => setCode(e.target.value)} autoFocus aria-invalid={!!err} aria-describedby={err ? 'login-err' : undefined} />
            ) : (
              <input key="otp" className="field code-field mono" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={6}
                placeholder="000000" value={code} onChange={(e) => setCode(digits(e.target.value))} autoFocus aria-invalid={!!err} aria-describedby={err ? 'login-err' : undefined} />
            )}
          </label>
          {errEl}
          <button className="btn-gold" type="submit" disabled={busy || (recovery ? code.trim().length < 9 : code.length !== 6)}>{busy ? 'Verifying…' : 'Verify'}</button>
          <button type="button" className="link-btn" onClick={() => { setRecovery((r) => !r); setCode(''); setErr(null); }}>
            {recovery ? 'Use an authenticator code' : 'Use a recovery code'}
          </button>
          <button type="button" className="link-btn" style={{ color: 'var(--muted-2)' }} onClick={() => backToPassword(null)}>Back to sign in</button>
        </form>
      )}

      {step === 'enroll' && (
        <form onSubmit={submitEnroll} className="stack">
          <div style={{ textAlign: 'center' }}>
            <h2 className="serif" style={{ fontSize: 24, fontWeight: 600 }}>Set up two-step sign-in</h2>
            <p className="hint" style={{ marginTop: 6 }}>Scan this with an authenticator app, then enter the 6-digit code it shows.</p>
          </div>
          {setup ? (
            <>
              <div className="qr-tile" role="img" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
              <div>
                <span className="label" id="secret-label">Or enter this key</span>
                <div className="secret-box" style={{ marginTop: 8 }}>
                  <code className="mono" aria-labelledby="secret-label">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
                  <CopyButton text={setup.secret} className="btn-ghost" />
                </div>
              </div>
            </>
          ) : (
            !err && <p className="hint" style={{ textAlign: 'center' }} role="status">{busy ? 'Preparing…' : ''}</p>
          )}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="sr-only">Authentication code</span>
            <input className="field code-field mono" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={6}
              placeholder="000000" value={code} onChange={(e) => setCode(digits(e.target.value))} aria-invalid={!!err} aria-describedby={err ? 'login-err' : undefined} />
          </label>
          {errEl}
          {!setup && err && <button type="button" className="btn-ghost" onClick={loadSetup}>Try again</button>}
          <button className="btn-gold" type="submit" disabled={busy || !setup || code.length !== 6}>{busy ? 'Checking…' : 'Turn on'}</button>
        </form>
      )}

      {step === 'codes' && <CodesStep codes={codes} onDone={finish} />}
    </main>
  );
}

function CodesStep({ codes, onDone }: { codes: string[]; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="stack">
      <div style={{ textAlign: 'center' }}>
        <h2 ref={ref} tabIndex={-1} className="serif" style={{ fontSize: 24, fontWeight: 600, outline: 'none' }}>Save your recovery codes</h2>
        <p className="hint" style={{ marginTop: 6 }}>If you lose your phone, each code signs you in once. They are shown only now.</p>
      </div>
      <RecoveryCodesView codes={codes} />
      <button className="btn-gold" disabled={busy} onClick={async () => { setBusy(true); await onDone(); }}>I&apos;ve saved these</button>
    </div>
  );
}
