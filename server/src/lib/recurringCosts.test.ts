import { describe, expect, it } from 'vitest';
import { costKey, dueDateIn, findPayment, merchantMatches, nextDueOnOrAfter, statusFor, type PaymentTx } from './recurringCosts';

const tx = (over: Partial<PaymentTx>): PaymentTx => ({ id: 't1', date: '2026-11-03', amount: 15.49, merchantName: 'Netflix', name: 'NETFLIX.COM', ...over });
const cost = { name: 'Netflix', amount: 15.49, dayOfMonth: 4, matchMerchant: null as string | null };

describe('dueDateIn', () => {
  it('uses the day, clamped to the month length', () => {
    expect(dueDateIn('2026-11', 4)).toBe('2026-11-04');
    expect(dueDateIn('2026-11', 31)).toBe('2026-11-30');
    expect(dueDateIn('2026-02', 30)).toBe('2026-02-28');
    expect(dueDateIn('2028-02', 31)).toBe('2028-02-29');
  });
});

describe('merchantMatches', () => {
  it('matches equal and word-contained merchants', () => {
    expect(merchantMatches('netflix', 'netflix')).toBe(true);
    expect(merchantMatches('netflix-com-866', 'netflix')).toBe(true);
    expect(merchantMatches('netflix', 'netflix-com-866')).toBe(true);
  });
  it('does not match partial words or empties', () => {
    expect(merchantMatches('netflixer', 'netflix')).toBe(false);
    expect(merchantMatches('', 'netflix')).toBe(false);
    expect(merchantMatches('spotify', 'netflix')).toBe(false);
  });
});

describe('findPayment', () => {
  it('matches on the normalized name when matchMerchant is unset', () => {
    expect(costKey(cost)).toBe('netflix');
    expect(findPayment(cost, [tx({})])?.id).toBe('t1');
  });
  it('prefers matchMerchant over the name', () => {
    const c = { ...cost, name: 'Streaming', matchMerchant: 'netflix' };
    expect(findPayment(c, [tx({})])?.id).toBe('t1');
    expect(findPayment({ ...c, matchMerchant: 'hulu' }, [tx({})])).toBeNull();
  });
  it('falls back to the raw transaction name when merchantName is null', () => {
    expect(findPayment(cost, [tx({ merchantName: null, name: 'NETFLIX.COM 866-579-7172' })])?.id).toBe('t1');
  });
  it('accepts amounts within +/-15% and rejects beyond', () => {
    const c = { ...cost, amount: 100 };
    expect(findPayment(c, [tx({ amount: 115 })])).not.toBeNull();
    expect(findPayment(c, [tx({ amount: 85 })])).not.toBeNull();
    expect(findPayment(c, [tx({ amount: 115.01 })])).toBeNull();
    expect(findPayment(c, [tx({ amount: 84.99 })])).toBeNull();
  });
  it('ignores refunds / money in', () => {
    expect(findPayment(cost, [tx({ amount: -15.49 })])).toBeNull();
  });
  it('picks the closest amount among several matches', () => {
    expect(findPayment(cost, [tx({ id: 'a', amount: 16.5 }), tx({ id: 'b', amount: 15.5 })])?.id).toBe('b');
  });
  it('returns null with no transactions or a blank key', () => {
    expect(findPayment(cost, [])).toBeNull();
    expect(findPayment({ ...cost, name: '!!!' }, [tx({})])).toBeNull();
  });
});

describe('statusFor', () => {
  it('is paid whenever a payment was found, even after the due date', () => {
    expect(statusFor('2026-11-04', '2026-11-19', true)).toBe('paid');
  });
  it('is overdue after the due date when unpaid', () => {
    expect(statusFor('2026-11-04', '2026-11-05', false)).toBe('overdue');
    expect(statusFor('2026-10-04', '2026-11-19', false)).toBe('overdue');
  });
  it('is due soon from 5 days out through the due date itself', () => {
    expect(statusFor('2026-11-24', '2026-11-19', false)).toBe('due_soon');
    expect(statusFor('2026-11-19', '2026-11-19', false)).toBe('due_soon');
  });
  it('is upcoming beyond 5 days', () => {
    expect(statusFor('2026-11-25', '2026-11-19', false)).toBe('upcoming');
    expect(statusFor('2026-12-04', '2026-11-19', false)).toBe('upcoming');
  });
});

describe('nextDueOnOrAfter', () => {
  it('returns this month when the day has not passed, else next month', () => {
    expect(nextDueOnOrAfter(25, '2026-11-19')).toBe('2026-11-25');
    expect(nextDueOnOrAfter(19, '2026-11-19')).toBe('2026-11-19');
    expect(nextDueOnOrAfter(4, '2026-11-19')).toBe('2026-12-04');
    expect(nextDueOnOrAfter(4, '2026-12-19')).toBe('2027-01-04');
  });
  it('clamps and can skip the current month', () => {
    expect(nextDueOnOrAfter(31, '2026-11-19')).toBe('2026-11-30');
    expect(nextDueOnOrAfter(31, '2027-01-31', true)).toBe('2027-02-28');
    expect(nextDueOnOrAfter(25, '2026-11-19', true)).toBe('2026-12-25');
  });
});
