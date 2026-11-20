import { money, plural, shortDay } from '../format';
import type { Cashflow } from '../types';
import { Sheet } from './Sheet';

export function ForecastSheet({ cf, onClose }: { cf: Cashflow; onClose: () => void }) {
  return (
    <Sheet title="Forecast" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="label">Cash on {shortDay(cf.horizonDate)}</span>
        <span className="serif tnum" style={{ fontSize: 40, fontWeight: 600, lineHeight: 1 }}>{money(cf.projected)}</span>
        <span className="row-sub">Now {money(cf.cashNow)} · {plural(cf.bills, 'bill')}, {plural(cf.paydays, 'payday')} ahead</span>
      </div>
      {cf.upcoming.length === 0 ? (
        <p className="muted" style={{ fontSize: 14 }}>No upcoming bills or paydays yet. Recurring items appear once there is enough history.</p>
      ) : (
        <div>
          {cf.upcoming.map((u, i) => (
            <div key={i} className="row">
              <span className="row-mid">
                <span className="row-title">{u.description}</span>
                <span className="row-sub">{shortDay(u.date)} · {u.direction === 'in' ? 'Payday' : 'Bill'}</span>
              </span>
              <span className={'row-amt' + (u.direction === 'in' ? ' pos' : '')}>{u.direction === 'in' ? '+' : '−'}{money(Math.abs(u.amount))}</span>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}
