import { describe, expect, it } from 'vitest';
import { buildForecast, occurrencesBetween, projectStreams, streamAnchor, type Stream } from './forecast';

// 2026-11-19 is a Thursday; its Monday is 2026-11-16. The 30-day window runs to 2026-12-19.
const FROM = '2026-11-19';
const TO = '2026-12-19';

const stream = (over: Partial<Stream>): Stream => ({
  description: 'Stream',
  frequency: 'MONTHLY',
  averageAmount: 100,
  direction: 'out',
  isActive: true,
  ...over,
});

describe('occurrencesBetween', () => {
  it('projects WEEKLY occurrences from predictedNextDate across 30 days', () => {
    const s = stream({ frequency: 'WEEKLY', predictedNextDate: '2026-11-20' });
    expect(occurrencesBetween(s, FROM, TO)).toEqual([
      '2026-11-20', '2026-11-27', '2026-12-04', '2026-12-11', '2026-12-18',
    ]);
  });

  it('projects BIWEEKLY occurrences from predictedNextDate across 30 days', () => {
    const s = stream({ frequency: 'BIWEEKLY', predictedNextDate: '2026-11-20' });
    expect(occurrencesBetween(s, FROM, TO)).toEqual(['2026-11-20', '2026-12-04', '2026-12-18']);
  });

  it('projects SEMI_MONTHLY occurrences on the 15th and the 30th (anchor day 15)', () => {
    const s = stream({ frequency: 'SEMI_MONTHLY', predictedNextDate: '2026-11-15' });
    expect(occurrencesBetween(s, FROM, TO)).toEqual(['2026-11-30', '2026-12-15']);
  });

  it('projects SEMI_MONTHLY occurrences on the 5th and 20th (anchor day 20)', () => {
    const s = stream({ frequency: 'SEMI_MONTHLY', predictedNextDate: '2026-11-20' });
    expect(occurrencesBetween(s, FROM, TO)).toEqual(['2026-11-20', '2026-12-05']);
  });

  it('projects MONTHLY occurrences across the window', () => {
    const s = stream({ frequency: 'MONTHLY', predictedNextDate: '2026-12-01' });
    expect(occurrencesBetween(s, FROM, TO)).toEqual(['2026-12-01']);
  });

  it('projects ANNUALLY occurrences', () => {
    const s = stream({ frequency: 'ANNUALLY', predictedNextDate: '2026-12-05' });
    expect(occurrencesBetween(s, FROM, TO)).toEqual(['2026-12-05']);
    expect(occurrencesBetween(s, '2026-12-06', '2027-12-31')).toEqual(['2027-12-05']);
  });

  it('skips forward over old anchors and only returns dates inside the window', () => {
    const s = stream({ frequency: 'WEEKLY', lastDate: '2026-10-01' });
    expect(occurrencesBetween(s, FROM, TO)).toEqual([
      '2026-11-19', '2026-11-26', '2026-12-03', '2026-12-10', '2026-12-17',
    ]);
  });

  it('returns nothing when there is no anchor or the anchor is after the window', () => {
    expect(occurrencesBetween(stream({ frequency: 'MONTHLY' }), FROM, TO)).toEqual([]);
    expect(occurrencesBetween(stream({ frequency: 'MONTHLY', predictedNextDate: '2027-01-02' }), FROM, TO)).toEqual([]);
  });

  it('projects a single predicted occurrence for an UNKNOWN frequency only when it is in the window', () => {
    expect(occurrencesBetween(stream({ frequency: 'UNKNOWN', predictedNextDate: '2026-12-02' }), FROM, TO)).toEqual(['2026-12-02']);
    expect(occurrencesBetween(stream({ frequency: 'UNKNOWN', predictedNextDate: '2027-02-02' }), FROM, TO)).toEqual([]);
  });

  it('keeps a Jan 31 MONTHLY stream on month-end days (Feb 28, Mar 31, Apr 30)', () => {
    const s = stream({ frequency: 'MONTHLY', predictedNextDate: '2027-01-31' });
    expect(occurrencesBetween(s, '2027-01-01', '2027-04-30')).toEqual([
      '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30',
    ]);
  });

  it('keeps a Jan 31 MONTHLY stream on month-end days in a leap year', () => {
    const s = stream({ frequency: 'MONTHLY', predictedNextDate: '2028-01-31' });
    expect(occurrencesBetween(s, '2028-01-01', '2028-03-31')).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
  });

  it('keeps a Feb 29 ANNUALLY stream on Feb 28 in non-leap years', () => {
    const s = stream({ frequency: 'ANNUALLY', predictedNextDate: '2028-02-29' });
    expect(occurrencesBetween(s, '2029-01-01', '2032-12-31')).toEqual([
      '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29',
    ]);
  });

  it('projects a MONTHLY stream whose lastDate is Jan 31 onto month-end days', () => {
    // BUG (forecast.ts: streamAnchor / occurrencesBetween): the fallback anchor is
    // addMonths(lastDate, 1) = Feb 28, and anchorDay is then read from that clamped
    // anchor (28), so every later occurrence drifts to the 28th: Feb 28, Mar 28, Apr 28.
    // The day-of-month should come from lastDate (31), giving Feb 28, Mar 31, Apr 30.
    const s = stream({ frequency: 'MONTHLY', lastDate: '2026-01-31' });
    expect(occurrencesBetween(s, '2026-02-01', '2026-04-30')).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });
});

describe('streamAnchor (fallback to lastDate + frequency)', () => {
  it('prefers predictedNextDate when present', () => {
    expect(streamAnchor({ frequency: 'WEEKLY', lastDate: '2026-11-01', predictedNextDate: '2026-11-25' })).toBe('2026-11-25');
  });

  it('falls back to lastDate + one period when predictedNextDate is missing', () => {
    expect(streamAnchor({ frequency: 'WEEKLY', lastDate: '2026-11-12' })).toBe('2026-11-19');
    expect(streamAnchor({ frequency: 'BIWEEKLY', lastDate: '2026-11-13', predictedNextDate: null })).toBe('2026-11-27');
    expect(streamAnchor({ frequency: 'MONTHLY', lastDate: '2026-11-10' })).toBe('2026-12-10');
    expect(streamAnchor({ frequency: 'ANNUALLY', lastDate: '2025-12-05' })).toBe('2026-12-05');
    expect(streamAnchor({ frequency: 'SEMI_MONTHLY', lastDate: '2026-11-05' })).toBe('2026-11-20');
  });

  it('returns null with neither date, or for UNKNOWN with only lastDate', () => {
    expect(streamAnchor({ frequency: 'MONTHLY' })).toBeNull();
    expect(streamAnchor({ frequency: 'UNKNOWN', lastDate: '2026-11-01' })).toBeNull();
  });

  it('projects from the lastDate fallback when predictedNextDate is absent', () => {
    const s = stream({ frequency: 'WEEKLY', lastDate: '2026-11-12' });
    expect(occurrencesBetween(s, FROM, TO)).toEqual([
      '2026-11-19', '2026-11-26', '2026-12-03', '2026-12-10', '2026-12-17',
    ]);
  });
});

describe('projectStreams', () => {
  it('ignores inactive and tombstoned streams', () => {
    const out = projectStreams([
      stream({ description: 'inactive', frequency: 'WEEKLY', predictedNextDate: '2026-11-20', isActive: false }),
      stream({ description: 'tombstoned', frequency: 'WEEKLY', predictedNextDate: '2026-11-20', status: 'TOMBSTONED' }),
      stream({ description: 'live', frequency: 'WEEKLY', predictedNextDate: '2026-11-20', isActive: true }),
    ], FROM, TO);
    expect(new Set(out.map((u) => u.description))).toEqual(new Set(['live']));
  });

  it('ignores streams with zero, negative or non-finite amounts', () => {
    const out = projectStreams([
      stream({ description: 'zero', averageAmount: 0, predictedNextDate: '2026-11-20' }),
      stream({ description: 'neg', averageAmount: -5, predictedNextDate: '2026-11-20' }),
      stream({ description: 'nan', averageAmount: Number.NaN, predictedNextDate: '2026-11-20' }),
    ], FROM, TO);
    expect(out).toEqual([]);
  });

  it('treats a stream without isActive as active', () => {
    const { isActive: _ignored, ...rest } = stream({ predictedNextDate: '2026-11-20' });
    expect(projectStreams([rest as Stream], FROM, TO)).toHaveLength(1);
  });

  it('returns occurrences sorted by date then description, with amounts rounded to cents', () => {
    const out = projectStreams([
      stream({ description: 'Zeta', predictedNextDate: '2026-11-20', averageAmount: 10.005, direction: 'in' }),
      stream({ description: 'Alpha', predictedNextDate: '2026-11-20', averageAmount: 3.333, direction: 'out' }),
      stream({ description: 'Early', frequency: 'UNKNOWN', predictedNextDate: '2026-11-19', averageAmount: 1, direction: 'out' }),
    ], FROM, TO);
    expect(out.map((u) => [u.date, u.description, u.direction])).toEqual([
      ['2026-11-19', 'Early', 'out'],
      ['2026-11-20', 'Alpha', 'out'],
      ['2026-11-20', 'Zeta', 'in'],
    ]);
    expect(out[1].amount).toBe(3.33);
  });
});

describe('buildForecast', () => {
  it('projects cashNow + inflows - outflows over 30 days (spec example)', () => {
    const f = buildForecast({
      cashNow: 1000,
      asOf: FROM,
      streams: [
        stream({ description: 'Rent', frequency: 'MONTHLY', predictedNextDate: '2026-12-01', averageAmount: 500, direction: 'out' }),
        stream({ description: 'Pay', frequency: 'BIWEEKLY', lastDate: '2026-11-13', averageAmount: 800, direction: 'in' }),
      ],
    });
    // Pay lands on 2026-11-27 and 2026-12-11 (lastDate + 14 days, then +14).
    expect(f.projected).toBe(1000 - 500 + 800 * 2);
    expect(f.bills).toBe(1);
    expect(f.paydays).toBe(2);
    expect(f.horizonDate).toBe(TO);
    expect(f.cashNow).toBe(1000);
    expect(f.upcoming.map((u) => u.date)).toEqual(['2026-11-27', '2026-12-01', '2026-12-11']);
  });

  it('ignores inactive streams in the projection', () => {
    const f = buildForecast({
      cashNow: 1000,
      asOf: FROM,
      streams: [stream({ predictedNextDate: '2026-11-25', averageAmount: 300, isActive: false })],
    });
    expect(f.projected).toBe(1000);
    expect(f.upcoming).toEqual([]);
    expect(f.bills).toBe(0);
  });

  it('excludes occurrences beyond the 30-day horizon', () => {
    const f = buildForecast({
      cashNow: 1000,
      asOf: FROM,
      streams: [stream({ predictedNextDate: '2026-12-25', averageAmount: 300 })],
    });
    expect(f.projected).toBe(1000);
    expect(f.upcoming).toEqual([]);
  });

  it('includes an occurrence dated on asOf itself', () => {
    const f = buildForecast({
      cashNow: 1000,
      asOf: FROM,
      streams: [stream({ frequency: 'WEEKLY', lastDate: '2026-11-12', averageAmount: 50 })],
    });
    expect(f.upcoming[0]).toMatchObject({ date: FROM, amount: 50, direction: 'out' });
  });

  it('rounds the projected balance to cents', () => {
    const f = buildForecast({
      cashNow: 0.1,
      asOf: FROM,
      streams: [stream({ predictedNextDate: '2026-11-25', averageAmount: 0.2, direction: 'in' })],
    });
    expect(f.projected).toBe(0.3);
  });

  it('builds the weekly series: current week at cashNow, then 4 projected weeks', () => {
    const f = buildForecast({ cashNow: 1000, asOf: FROM, streams: [] });
    const current = f.weekly.find((w) => !w.projected && w.weekStart === '2026-11-16');
    expect(current).toEqual({ weekStart: '2026-11-16', value: 1000, projected: false });
    const projected = f.weekly.filter((w) => w.projected);
    expect(projected.map((w) => w.weekStart)).toEqual(['2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14']);
    expect(projected.every((w) => w.value === 1000)).toBe(true);
  });

  it('projects each week as the running balance at the end of that week', () => {
    const f = buildForecast({
      cashNow: 1000,
      asOf: FROM,
      streams: [
        stream({ description: 'Rent', predictedNextDate: '2026-11-30', averageAmount: 200, direction: 'out' }),
        stream({ description: 'Pay', frequency: 'WEEKLY', predictedNextDate: '2026-11-27', averageAmount: 150, direction: 'in' }),
      ],
    });
    const byStart = Object.fromEntries(f.weekly.filter((w) => w.projected).map((w) => [w.weekStart, w.value]));
    // Week of 11-23 ends 11-29: Pay on 11-27 only.
    expect(byStart['2026-11-23']).toBe(1000 + 150);
    // Week of 11-30 ends 12-06: Rent on 11-30 (-200), Pay on 12-04 (+150); running total 1100.
    expect(byStart['2026-11-30']).toBe(1000 + 150 + 150 - 200);
  });

  it('uses snapshot history for past weeks, taking the last value on or before each week end', () => {
    const f = buildForecast({
      cashNow: 1000,
      asOf: FROM,
      streams: [],
      cashHistory: [
        { date: '2026-11-01', cash: 800 },
        { date: '2026-11-08', cash: 850 },
        { date: '2026-11-15', cash: 900 },
      ],
    });
    const past = f.weekly.filter((w) => !w.projected && w.weekStart !== '2026-11-16');
    expect(past).toEqual([
      { weekStart: '2026-10-26', value: 800, projected: false },
      { weekStart: '2026-11-02', value: 850, projected: false },
      { weekStart: '2026-11-09', value: 900, projected: false },
    ]);
  });

  it('omits past weeks that have no snapshot history', () => {
    const f = buildForecast({ cashNow: 1000, asOf: FROM, streams: [] });
    expect(f.weekly.filter((w) => !w.projected)).toEqual([{ weekStart: '2026-11-16', value: 1000, projected: false }]);
  });

  it('returns 4 past weeks before the current week (spec §5)', () => {
    // BUG (forecast.ts:buildForecast, loop `for (let i = nPast - 1; i >= 1; i--)`): with
    // pastWeeks = 4 the loop runs for i = 3, 2, 1, so only 3 past weeks are emitted.
    // Spec §5 says "4 past weeks of actual end-of-week cash".
    const history = [
      { date: '2026-10-18', cash: 700 },
      { date: '2026-10-25', cash: 750 },
      { date: '2026-11-01', cash: 800 },
      { date: '2026-11-08', cash: 850 },
      { date: '2026-11-15', cash: 900 },
    ];
    const f = buildForecast({ cashNow: 1000, asOf: FROM, streams: [], cashHistory: history });
    expect(f.weekly.filter((w) => !w.projected && w.weekStart !== '2026-11-16')).toHaveLength(4);
  });
});
