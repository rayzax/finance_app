import { useState } from 'react';
import type { Tx } from '../types';

export function TxAvatar({ tx }: { tx: Tx }) {
  const [bad, setBad] = useState(false);
  const name = tx.merchantName || tx.name || '?';
  const base = {
    width: 38, height: 38, flexShrink: 0, borderRadius: 19, border: '1px solid rgba(201,168,106,0.35)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  } as const;
  if (tx.logoUrl && !bad) {
    return <span style={base}><img src={tx.logoUrl} alt="" width={38} height={38} onError={() => setBad(true)} style={{ display: 'block' }} /></span>;
  }
  return (
    <span aria-hidden="true" className="serif" style={{ ...base, fontSize: 18, fontWeight: 600, color: 'var(--gold)' }}>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
