import { useRef, useState } from 'react';
import { chartDay, money } from '../format';

const W = 350;
const H = 112;

export function NetWorthChart({ series }: { series: { date: string; value: number }[] }) {
  const [idx, setIdx] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const pts = series.length === 1 ? [series[0], series[0]] : series;
  if (pts.length === 0) return <div style={{ height: H }} />;

  const vals = pts.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const xs = (i: number) => (i / (pts.length - 1)) * W;
  const ys = (v: number) => (max === min ? 56 : 104 - ((v - min) / (max - min)) * 94);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)} ${ys(p.value).toFixed(1)}`).join(' ');
  const last = pts.length - 1;

  const scrub = (e: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !r.width) return;
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setIdx(Math.round(f * last));
  };
  const cur = idx !== null ? pts[idx] : null;
  const label = `Net worth chart, ${chartDay(pts[0].date)} to ${chartDay(pts[last].date)}, from ${money(pts[0].value)} to ${money(pts[last].value)}`;

  return (
    <div className="chart-wrap" role="img" aria-label={label}>
      {cur && idx !== null && (
        <div className="chart-tip" style={{ left: `clamp(70px, ${(xs(idx) / W) * 100}%, calc(100% - 70px))` }}>
          <span className="muted">{chartDay(cur.date)}</span>
          <strong className="tnum">{money(cur.value)}</strong>
        </div>
      )}
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ display: 'block', overflow: 'visible', aspectRatio: `${W} / ${H}` }}
        onPointerDown={(e) => { (e.currentTarget as Element).setPointerCapture(e.pointerId); scrub(e); }}
        onPointerMove={(e) => { if (e.buttons || e.pointerType === 'touch' || idx !== null) scrub(e); }}
        onPointerUp={() => setIdx(null)}
        onPointerCancel={() => setIdx(null)}
        onPointerLeave={() => setIdx(null)}
      >
        <path d="M0 111.5 H350" stroke="rgba(201,168,106,0.16)" strokeWidth="1" fill="none" />
        <path className="draw" pathLength={1} d={d} stroke="#C9A86A" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={xs(last)} cy={ys(pts[last].value)} r="4" fill="#0C1411" stroke="#E2C58C" strokeWidth="2" />
        {cur && idx !== null && (
          <>
            <path d={`M${xs(idx)} 0 V${H}`} stroke="rgba(201,168,106,0.4)" strokeWidth="1" />
            <circle cx={xs(idx)} cy={ys(cur.value)} r="4.5" fill="#C9A86A" stroke="#0C1411" strokeWidth="2" />
          </>
        )}
      </svg>
    </div>
  );
}
