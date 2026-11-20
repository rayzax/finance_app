import type { CSSProperties } from 'react';

export function Skeleton({ w = '100%', h = 14, r, style }: { w?: number | string; h?: number; r?: number; style?: CSSProperties }) {
  return <div className="sk" aria-hidden="true" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner" role="alert">
      <span>{message}</span>
      {onRetry && <button onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return <span className="sr-only" role="status">{label}</span>;
}
