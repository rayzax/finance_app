import { useState } from 'react';

/** Never throws; resolves false when the Clipboard API is unavailable or refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// no 0/O/1/l/I look-alikes; 54 symbols
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** 16 characters from crypto.getRandomValues, with rejection sampling so every symbol is equally likely. */
export function generateTempPassword(length = 16): string {
  const n = PW_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < length) {
    const buf = new Uint8Array(length * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && out.length < length) out += PW_ALPHABET[b % n];
    }
  }
  return out;
}

export function CopyButton({ text, label = 'Copy', className = 'btn-ghost' }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'fail'>('idle');
  const onClick = async () => {
    const ok = await copyText(text);
    setState(ok ? 'done' : 'fail');
    window.setTimeout(() => setState('idle'), 2000);
  };
  return (
    <button type="button" className={className} onClick={onClick} aria-live="polite">
      {state === 'done' ? 'Copied' : state === 'fail' ? 'Copy failed' : label}
    </button>
  );
}

/** The ten recovery codes with Copy and Download. The parent decides what "done" means. */
export function RecoveryCodesView({ codes }: { codes: string[] }) {
  const text = `Reserve recovery codes\nEach code works once. Keep them somewhere safe.\n\n${codes.join('\n')}\n`;
  return (
    <>
      <ul className="codes-grid mono" aria-label="Recovery codes">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="pair">
        <CopyButton text={codes.join('\n')} label="Copy" className="btn-ghost" />
        <button type="button" className="btn-ghost" onClick={() => downloadText('reserve-recovery-codes.txt', text)}>Download .txt</button>
      </div>
    </>
  );
}
