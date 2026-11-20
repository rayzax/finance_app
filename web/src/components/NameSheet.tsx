import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../api';
import type { Me } from '../types';
import { Sheet } from './Sheet';
import { ErrorBanner } from './bits';

export function NameSheet({ current, onClose }: { current: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = name.trim().length > 0 && name.trim() !== current;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const me = await api<Me>('/api/auth/me', { method: 'PATCH', body: { displayName: name.trim() } });
      qc.setQueryData(['me'], me);
      onClose();
    } catch (ex) {
      setErr(errMsg(ex));
      setBusy(false);
    }
  };

  return (
    <Sheet title="Your name" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <p className="hint">Shown in your greeting and on your avatar. Your initials come from the first and last words.</p>
        <label className="stack" style={{ gap: 8 }}>
          <span className="sr-only">Display name</span>
          <input className="field" autoComplete="name" maxLength={60} placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        </label>
        {err && <ErrorBanner message={err} />}
        <button className="btn-gold" type="submit" disabled={!ok || busy}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
    </Sheet>
  );
}
