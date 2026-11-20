import { describe, expect, it } from 'vitest';
import {
  contributionRatePerDay, evaluateGoal, expectedPct, monthsLeft, projectDate, savingsRatePerDay, summarizeGoals,
} from './goals';

// Created 2026-01-01, due 2027-01-01 (365 days). Half way is 2026-07-02 (182 days in -> 49.9%).
const base = { targetAmount: 10_000, createdDate: '2026-01-01', targetDate: '2027-01-01' as string | null };
const ev = (current: number, today: string, over: Partial<typeof base> = {}) => evaluateGoal({ ...base, ...over, current, today });

describe('expectedPct', () => {
  it('is linear between created and target date', () => {
    expect(expectedPct('2026-01-01', '2026-01-11', '2026-01-01')).toBe(0);
    expect(expectedPct('2026-01-01', '2026-01-11', '2026-01-06')).toBe(50);
    expect(expectedPct('2026-01-01', '2026-01-11', '2026-01-11')).toBe(100);
  });
  it('is 100 for a past target and for a target on or before creation', () => {
    expect(expectedPct('2026-01-01', '2026-03-01', '2026-06-01')).toBe(100);
    expect(expectedPct('2026-03-01', '2026-03-01', '2026-02-01')).toBe(100);
  });
  it('is 0 when today precedes creation', () => {
    expect(expectedPct('2026-03-01', '2026-06-01', '2026-02-01')).toBe(0);
  });
});

describe('monthsLeft', () => {
  it('rounds up and never drops below 1', () => {
    expect(monthsLeft('2026-11-19', '2027-05-19')).toBe(6);
    expect(monthsLeft('2026-11-19', '2026-11-25')).toBe(1);
    expect(monthsLeft('2026-11-19', '2026-11-19')).toBe(1);
    expect(monthsLeft('2026-11-19', '2026-01-01')).toBe(1);
  });
});

describe('evaluateGoal pace', () => {
  it('is on track within +/-5 points of the schedule', () => {
    // expected 50% mid-way
    expect(ev(5000, '2026-07-02').pace).toBe('on_track');
    expect(ev(5400, '2026-07-02').pace).toBe('on_track'); // +4
    expect(ev(4600, '2026-07-02').pace).toBe('on_track'); // -4
  });
  it('is ahead at +5 points or more', () => {
    expect(ev(5500, '2026-07-02').pace).toBe('ahead');
    expect(ev(8000, '2026-07-02').pace).toBe('ahead');
  });
  it('is behind below -5 points', () => {
    expect(ev(4400, '2026-07-02').pace).toBe('behind');
    expect(ev(0, '2026-07-02').pace).toBe('behind');
  });
  it('is on track exactly at the -5 boundary and ahead exactly at +5 (spec edges)', () => {
    // 10 day goal, 5 days in = 50% expected
    const t = { targetAmount: 100, createdDate: '2026-01-01', targetDate: '2026-01-11' as string | null, today: '2026-01-06' };
    expect(evaluateGoal({ ...t, current: 45 }).pace).toBe('on_track');
    expect(evaluateGoal({ ...t, current: 44 }).pace).toBe('behind');
    expect(evaluateGoal({ ...t, current: 55 }).pace).toBe('ahead');
    expect(evaluateGoal({ ...t, current: 54 }).pace).toBe('on_track');
  });
  it('is done once current reaches the target, even past the date', () => {
    expect(ev(10_000, '2026-07-02').pace).toBe('done');
    expect(ev(12_500, '2026-07-02')).toMatchObject({ pace: 'done', pct: 100, remaining: 0, monthlyNeeded: null });
    expect(ev(10_000, '2027-06-01').pace).toBe('done');
  });
  it('is no_date without a target date', () => {
    expect(ev(2000, '2026-07-02', { targetDate: null })).toMatchObject({ pace: 'no_date', monthlyNeeded: null, expectedPct: null, pct: 20, remaining: 8000 });
  });
  it('done with no date has no expected pct', () => {
    expect(ev(10_000, '2026-07-02', { targetDate: null })).toMatchObject({ pace: 'done', expectedPct: null });
  });
  it('is behind once the date has passed and the goal is short', () => {
    expect(ev(9000, '2027-02-01')).toMatchObject({ pace: 'behind', expectedPct: 100, monthlyNeeded: 1000 });
  });
  it('past date within 5 points of the target is still on track', () => {
    expect(ev(9500, '2027-02-01').pace).toBe('on_track');
  });
  it('a goal created today is on track at 0%', () => {
    expect(ev(0, '2026-01-01').pace).toBe('on_track');
  });
});

describe('evaluateGoal amounts', () => {
  it('computes pct (capped, one decimal), remaining and monthlyNeeded', () => {
    expect(evaluateGoal({ current: 4200, targetAmount: 10_000, createdDate: '2026-11-19', targetDate: '2027-05-19', today: '2026-11-19' }))
      .toMatchObject({ pct: 42, remaining: 5800, monthlyNeeded: 966.67 });
    expect(ev(3333.33, '2026-07-02').pct).toBe(33.3);
  });
  it('clamps a negative balance to 0% but still reports the full remaining', () => {
    expect(ev(-200, '2026-07-02')).toMatchObject({ pct: 0, remaining: 10_200 });
  });
  it('divides by at least one month when the date is near or past', () => {
    expect(ev(8000, '2026-12-28')).toMatchObject({ monthlyNeeded: 2000 });
    expect(ev(8000, '2027-03-01')).toMatchObject({ monthlyNeeded: 2000 });
  });
});

describe('savingsRatePerDay', () => {
  const pts = [{ date: '2026-10-01', value: 1000 }, { date: '2026-10-31', value: 1300 }, { date: '2026-11-19', value: 1570 }];
  it('uses first to last inside the window', () => {
    expect(savingsRatePerDay(pts, '2026-11-19')).toBeCloseTo(570 / 49, 6);
  });
  it('ignores points older than the window', () => {
    const old = [{ date: '2026-01-01', value: 0 }, ...pts];
    expect(savingsRatePerDay(old, '2026-11-19')).toBeCloseTo(570 / 49, 6);
  });
  it('is null with one point or under a week of history', () => {
    expect(savingsRatePerDay([pts[2]], '2026-11-19')).toBeNull();
    expect(savingsRatePerDay([{ date: '2026-11-15', value: 1 }, { date: '2026-11-19', value: 9 }], '2026-11-19')).toBeNull();
  });
  it('is negative when balances fall', () => {
    expect(savingsRatePerDay([{ date: '2026-11-01', value: 500 }, { date: '2026-11-19', value: 200 }], '2026-11-19')).toBeLessThan(0);
  });
});

describe('contributionRatePerDay', () => {
  it('is null with no contributions in the window', () => {
    expect(contributionRatePerDay([], '2026-11-19')).toBeNull();
    expect(contributionRatePerDay([{ date: '2026-01-01', amount: 500 }], '2026-11-19')).toBeNull();
  });
  it('spreads contributions over at least 30 days', () => {
    expect(contributionRatePerDay([{ date: '2026-11-18', amount: 300 }], '2026-11-19')).toBeCloseTo(10, 6);
  });
  it('averages over the span since the earliest contribution, capped at the window', () => {
    expect(contributionRatePerDay([{ date: '2026-09-20', amount: 400 }, { date: '2026-10-20', amount: 400 }], '2026-11-19')).toBeCloseTo(800 / 60, 6);
  });
  it('nets withdrawals', () => {
    expect(contributionRatePerDay([{ date: '2026-10-01', amount: 100 }, { date: '2026-11-01', amount: -250 }], '2026-11-19')).toBeLessThan(0);
  });
});

describe('projectDate', () => {
  it('projects from the rate', () => {
    expect(projectDate(0, 100, 10, '2026-11-19')).toBe('2026-11-29');
    expect(projectDate(0, 105, 10, '2026-11-19')).toBe('2026-11-30');
  });
  it('is null for a non-positive, missing or non-finite rate', () => {
    expect(projectDate(0, 100, 0, '2026-11-19')).toBeNull();
    expect(projectDate(0, 100, -3, '2026-11-19')).toBeNull();
    expect(projectDate(0, 100, null, '2026-11-19')).toBeNull();
    expect(projectDate(0, 100, NaN, '2026-11-19')).toBeNull();
  });
  it('is today when already funded and null when absurdly far', () => {
    expect(projectDate(100, 100, 5, '2026-11-19')).toBe('2026-11-19');
    expect(projectDate(0, 1e9, 0.01, '2026-11-19')).toBeNull();
  });
});

describe('summarizeGoals', () => {
  it('caps saved per goal and counts paces', () => {
    const s = summarizeGoals([
      { current: 12_000, targetAmount: 10_000, pace: 'done' },
      { current: 1000, targetAmount: 5000, pace: 'behind' },
      { current: 500, targetAmount: 1000, pace: 'on_track' },
      { current: 100, targetAmount: 1000, pace: 'no_date' },
      { current: -50, targetAmount: 1000, pace: 'ahead' },
    ]);
    expect(s).toEqual({ totalSaved: 11_600, totalTarget: 18_000, onTrack: 3, behind: 1 });
  });
  it('handles no goals', () => {
    expect(summarizeGoals([])).toEqual({ totalSaved: 0, totalTarget: 0, onTrack: 0, behind: 0 });
  });
});
