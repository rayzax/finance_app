import { useEffect, useRef, useState, type ReactNode } from 'react';

const THRESHOLD = 60;

export function PullToRefresh({ onRefresh, children }: { onRefresh: () => Promise<unknown>; children: ReactNode }) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const s = useRef({ y: 0, active: false, pull: 0, busy: false });
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

  useEffect(() => {
    const ts = (e: TouchEvent) => {
      if (s.current.busy || window.scrollY > 0 || document.body.classList.contains('sheet-open')) return;
      s.current.y = e.touches[0].clientY;
      s.current.active = true;
    };
    const tm = (e: TouchEvent) => {
      if (!s.current.active) return;
      const dy = e.touches[0].clientY - s.current.y;
      if (dy <= 0 || window.scrollY > 0) {
        if (s.current.pull) {
          s.current.pull = 0;
          setPull(0);
        }
        return;
      }
      const p = Math.min(dy * 0.5, 90);
      s.current.pull = p;
      setDragging(true);
      setPull(p);
      if (e.cancelable) e.preventDefault();
    };
    const te = async () => {
      if (!s.current.active) return;
      s.current.active = false;
      setDragging(false);
      if (s.current.pull >= THRESHOLD) {
        s.current.busy = true;
        setBusy(true);
        setPull(THRESHOLD);
        try {
          await refresh.current();
        } catch {
          /* errors surface through the queries themselves */
        }
        s.current.busy = false;
        setBusy(false);
      }
      s.current.pull = 0;
      setPull(0);
    };
    document.addEventListener('touchstart', ts, { passive: true });
    document.addEventListener('touchmove', tm, { passive: false });
    document.addEventListener('touchend', te);
    document.addEventListener('touchcancel', te);
    return () => {
      document.removeEventListener('touchstart', ts);
      document.removeEventListener('touchmove', tm);
      document.removeEventListener('touchend', te);
      document.removeEventListener('touchcancel', te);
    };
  }, []);

  const text = busy ? 'Syncing…' : pull >= THRESHOLD ? 'Release to sync' : 'Pull to sync';
  return (
    <>
      <div className="ptr" aria-live="polite" style={{ opacity: Math.min(1, pull / THRESHOLD) }}>{pull > 0 || busy ? text : ''}</div>
      <div style={pull ? { transform: `translateY(${pull}px)`, transition: dragging ? 'none' : 'transform 200ms cubic-bezier(.2,.8,.2,1)' } : undefined}>
        {children}
      </div>
    </>
  );
}
