import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Ico } from '../icons';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const DUR = 240;

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** Mount it only while it is open; it animates out and then calls onClose. */
export function Sheet({ title, onClose, children }: Props) {
  const [closing, setClosing] = useState(false);
  const [dragY, setDragY] = useState<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ startY: 0, t: 0, y: 0 });
  const closingRef = useRef(false);

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(onClose, reduce ? 0 : DUR);
  }, [onClose]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    document.body.classList.add('sheet-open');
    const first = sheetRef.current?.querySelector<HTMLElement>('[data-autofocus]') ?? sheetRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? sheetRef.current)?.focus({ preventScroll: true });
    return () => {
      document.body.classList.remove('sheet-open');
      prev?.focus?.({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab' || !sheetRef.current) return;
    const els = Array.from(sheetRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!els.length) return;
    const first = els[0];
    const last = els[els.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === sheetRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, t: Date.now(), y: 0 };
    setDragY(0);
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragY === null) return;
    const y = Math.max(0, e.clientY - drag.current.startY);
    drag.current.y = y;
    setDragY(y);
  };
  const onUp = () => {
    if (dragY === null) return;
    const { y, t } = drag.current;
    const v = y / Math.max(1, Date.now() - t);
    setDragY(null);
    if (y > 110 || (y > 40 && v > 0.6)) close();
  };

  return createPortal(
    <div className={'sheet-wrap' + (closing ? ' closing' : '')} onKeyDown={onKeyDown}>
      <div className="sheet-backdrop" onClick={close} aria-hidden="true" />
      <div
        ref={sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={dragY !== null ? { transform: `translateY(${dragY}px)`, animation: 'none' } : undefined}
      >
        <div className="sheet-grab" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="sheet-handle" />
          <div className="sheet-head">
            <h2>{title}</h2>
            <button className="round-btn" aria-label="Close" onClick={close} onPointerDown={(e) => e.stopPropagation()} style={{ borderColor: 'transparent', color: 'var(--muted-2)' }}>
              <Ico name="close" size={18} />
            </button>
          </div>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
