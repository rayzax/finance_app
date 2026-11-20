import { describe, expect, it } from 'vitest';
import { buildTransactionDoc, chunk, collectChanges, type FetchPage, type SyncPage } from './sync';

const MUTATION = { response: { data: { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' } } };

const page = (over: Partial<SyncPage> = {}): SyncPage => ({
  added: [], modified: [], removed: [], next_cursor: 'cursor', has_more: false, ...over,
});

const tx = (over: Record<string, unknown> = {}): any => ({
  transaction_id: 'tx-1',
  account_id: 'acc-1',
  date: '2026-11-18',
  name: 'TRADER JOE\'S #123',
  merchant_name: "Trader Joe's",
  amount: 42.5,
  pending: false,
  logo_url: null,
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' },
  ...over,
});

describe('collectChanges', () => {
  it('pages until has_more is false, accumulating changes and keeping the last cursor', async () => {
    const cursors: (string | undefined)[] = [];
    const pages: SyncPage[] = [
      page({ added: [tx({ transaction_id: 'a' })] as any, next_cursor: 'c1', has_more: true }),
      page({ added: [tx({ transaction_id: 'b' })] as any, modified: [tx({ transaction_id: 'm' })] as any, next_cursor: 'c2', has_more: false }),
    ];
    const fetchPage: FetchPage = async (cursor) => {
      cursors.push(cursor);
      return pages[cursors.length - 1];
    };
    const r = await collectChanges(fetchPage, 'start');
    expect(cursors).toEqual(['start', 'c1']);
    expect(r.added.map((t) => t.transaction_id)).toEqual(['a', 'b']);
    expect(r.modified.map((t) => t.transaction_id)).toEqual(['m']);
    expect(r.nextCursor).toBe('c2');
  });

  it('starts with an undefined cursor when there is no stored cursor', async () => {
    const cursors: (string | undefined)[] = [];
    await collectChanges(async (c) => { cursors.push(c); return page(); }, null);
    expect(cursors).toEqual([undefined]);
  });

  it('restarts from the ORIGINAL cursor after a mutation during pagination', async () => {
    const cursors: (string | undefined)[] = [];
    let call = 0;
    const fetchPage: FetchPage = async (cursor) => {
      cursors.push(cursor);
      call++;
      if (call === 1) return page({ next_cursor: 'c1', has_more: true });
      if (call === 2) throw MUTATION;
      return page({ next_cursor: 'c-final', has_more: false });
    };
    const r = await collectChanges(fetchPage, 'start');
    expect(cursors).toEqual(['start', 'c1', 'start']);
    expect(r.nextCursor).toBe('c-final');
  });

  it('discards pages collected by a failed attempt', async () => {
    let call = 0;
    const fetchPage: FetchPage = async () => {
      call++;
      // Attempt 1 fails immediately; attempt 2 collects one page then fails; attempt 3 is clean.
      if (call === 1) throw MUTATION;
      if (call === 2) return page({ added: [tx({ transaction_id: 'stale' })] as any, next_cursor: 'x', has_more: true });
      if (call === 3) throw MUTATION;
      return page({ added: [tx({ transaction_id: 'fresh' })] as any, next_cursor: 'ok', has_more: false });
    };
    const r = await collectChanges(fetchPage, 'start');
    expect(r.added.map((t) => t.transaction_id)).toEqual(['fresh']);
    expect(r.nextCursor).toBe('ok');
  });

  it('gives up after 3 tries on repeated mutation errors and rethrows', async () => {
    let calls = 0;
    const fetchPage: FetchPage = async () => { calls++; throw MUTATION; };
    await expect(collectChanges(fetchPage, 'start')).rejects.toBe(MUTATION);
    expect(calls).toBe(3);
  });

  it('succeeds on the third try (two mutations, then a clean run)', async () => {
    let calls = 0;
    const fetchPage: FetchPage = async () => {
      calls++;
      if (calls < 3) throw MUTATION;
      return page({ next_cursor: 'done' });
    };
    const r = await collectChanges(fetchPage, 'start');
    expect(calls).toBe(3);
    expect(r.nextCursor).toBe('done');
  });

  it('does not retry other Plaid errors', async () => {
    let calls = 0;
    const other = { response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } } };
    const fetchPage: FetchPage = async () => { calls++; throw other; };
    await expect(collectChanges(fetchPage, 'start')).rejects.toBe(other);
    expect(calls).toBe(1);
  });

  it('honours a custom maxTries', async () => {
    let calls = 0;
    const fetchPage: FetchPage = async () => { calls++; throw MUTATION; };
    await expect(collectChanges(fetchPage, 'start', 1)).rejects.toBe(MUTATION);
    expect(calls).toBe(1);
  });
});

describe('buildTransactionDoc', () => {
  const ctx = { itemId: 'item-1', now: '2026-11-19T00:00:00.000Z' };

  it('maps a new transaction from its Plaid personal finance category', () => {
    const doc = buildTransactionDoc(tx(), ctx);
    expect(doc).toMatchObject({
      itemId: 'item-1',
      accountId: 'acc-1',
      date: '2026-11-18',
      month: '2026-11',
      merchantName: "Trader Joe's",
      amount: 42.5,
      pfcPrimary: 'FOOD_AND_DRINK',
      pfcDetailed: 'FOOD_AND_DRINK_GROCERIES',
      category: 'groceries',
      userCategory: null,
      kind: 'spend',
      pending: false,
      logoUrl: null,
      updatedAt: '2026-11-19T00:00:00.000Z',
    });
  });

  it('keeps a user-set category when a transaction is modified', () => {
    const doc = buildTransactionDoc(tx(), { ...ctx, existingUserCategory: 'travel' });
    expect(doc.category).toBe('travel');
    expect(doc.userCategory).toBe('travel');
    expect(doc.kind).toBe('spend');
  });

  it('keeps a user-set income/transfer category and derives kind from it', () => {
    const doc = buildTransactionDoc(tx(), { ...ctx, existingUserCategory: 'transfer' });
    expect(doc.category).toBe('transfer');
    expect(doc.kind).toBe('transfer');
  });

  it('prefers the user category over a merchant rule', () => {
    const doc = buildTransactionDoc(tx(), { ...ctx, existingUserCategory: 'travel', merchantRule: 'dining' });
    expect(doc.category).toBe('travel');
  });

  it('applies a merchant rule over the Plaid mapping when there is no user category', () => {
    const doc = buildTransactionDoc(tx(), { ...ctx, merchantRule: 'dining' });
    expect(doc.category).toBe('dining');
    expect(doc.userCategory).toBeNull();
    expect(doc.kind).toBe('spend');
  });

  it('derives kind income and transfer from the mapped category', () => {
    expect(buildTransactionDoc(tx({ personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_WAGES' } }), ctx).kind).toBe('income');
    expect(buildTransactionDoc(tx({ personal_finance_category: { primary: 'TRANSFER_OUT', detailed: 'X' } }), ctx).kind).toBe('transfer');
    expect(
      buildTransactionDoc(tx({ personal_finance_category: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } }), ctx).kind,
    ).toBe('transfer');
  });

  it('falls back to other when the transaction has no personal finance category', () => {
    const doc = buildTransactionDoc(tx({ personal_finance_category: undefined }), ctx);
    expect(doc.category).toBe('other');
    expect(doc.pfcPrimary).toBeNull();
    expect(doc.pfcDetailed).toBeNull();
  });

  it('uses the personal finance category icon when there is no logo', () => {
    const doc = buildTransactionDoc(tx({ logo_url: null, personal_finance_category_icon_url: 'https://icons/x.png' }), ctx);
    expect(doc.logoUrl).toBe('https://icons/x.png');
  });

  it('uses the current time when no now is supplied', () => {
    const doc = buildTransactionDoc(tx(), { itemId: 'item-1' });
    expect(Number.isNaN(Date.parse(doc.updatedAt))).toBe(false);
  });
});

describe('chunk', () => {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);

  it('splits at 400 items per batch', () => {
    const parts = chunk(range(801), 400);
    expect(parts.map((p) => p.length)).toEqual([400, 400, 1]);
  });

  it('keeps an exact multiple of 400 in one or more full batches', () => {
    expect(chunk(range(400), 400).map((p) => p.length)).toEqual([400]);
    expect(chunk(range(800), 400).map((p) => p.length)).toEqual([400, 400]);
  });

  it('keeps order and loses no items', () => {
    const input = range(1234);
    expect(chunk(input, 400).flat()).toEqual(input);
  });

  it('returns no batches for an empty array and one batch for small inputs', () => {
    expect(chunk([], 400)).toEqual([]);
    expect(chunk([1, 2, 3], 400)).toEqual([[1, 2, 3]]);
  });
});
