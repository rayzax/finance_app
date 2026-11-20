import { monthYear, recentMonths } from '../format';
import { Ico } from '../icons';
import { Sheet } from './Sheet';

export function MonthPicker({ value, onPick, onClose }: { value: string; onPick: (m: string) => void; onClose: () => void }) {
  return (
    <Sheet title="Month" onClose={onClose}>
      <div role="group" aria-label="Choose month">
        {recentMonths(12).map((m) => (
          <button key={m} className="row" aria-pressed={m === value} data-autofocus={m === value ? '' : undefined}
            style={{ justifyContent: 'space-between' }} onClick={() => { onPick(m); onClose(); }}>
            <span className="row-title" style={{ color: m === value ? 'var(--gold)' : undefined }}>{monthYear(m)}</span>
            {m === value && <span style={{ color: 'var(--gold)' }}><Ico name="check" size={18} sw={2} /></span>}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
