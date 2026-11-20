import type { Transaction as PlaidTx, RemovedTransaction, AccountBase } from 'plaid';
import { col, db, AccountDoc, ItemDoc, TransactionDoc } from './db';
import { decryptToken } from './crypto';
import { plaid, plaidErrorCode, logPlaidError } from './plaid';
import { accountGroup, kindOf, mapCategory, normalizeMerchant, GROUP_ORDER, LIABILITY_GROUPS, Group } from './categories';
import { monthOf, todayStr } from './dates';

const MUTATION_ERROR = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';
const BATCH_LIMIT = 400;
const MAX_SYNC_TRIES = 3;

export interface SyncPage {
  added: PlaidTx[];
  modified: PlaidTx[];
  removed: RemovedTransaction[];
  next_cursor: string;
  has_more: boolean;
}
export type FetchPage = (cursor: string | undefined) => Promise<SyncPage>;

export interface Changes {
  added: PlaidTx[];
  modified: PlaidTx[];
  removed: RemovedTransaction[];
  nextCursor: string;
}

/**
 * Page through /transactions/sync until has_more is false. If Plaid reports a mutation
 * during pagination, restart from the ORIGINAL cursor (up to `maxTries` attempts).
 */
export async function collectChanges(
  fetchPage: FetchPage,
  startCursor: string | null | undefined,
  maxTries = MAX_SYNC_TRIES,
  errorCode: (e: unknown) => string | undefined = plaidErrorCode,
): Promise<Changes> {
  for (let attempt = 1; ; attempt++) {
    try {
      const out: Changes = { added: [], modified: [], removed: [], nextCursor: startCursor ?? '' };
      let cursor: string | undefined = startCursor || undefined;
      for (;;) {
        const page = await fetchPage(cursor);
        out.added.push(...page.added);
        out.modified.push(...page.modified);
        out.removed.push(...page.removed);
        cursor = page.next_cursor;
        out.nextCursor = page.next_cursor;
        if (!page.has_more) return out;
      }
    } catch (e) {
      if (errorCode(e) === MUTATION_ERROR && attempt < maxTries) continue;
      throw e;
    }
  }
}

export type WriteOp =
  | { type: 'set'; ref: FirebaseFirestore.DocumentReference; data: object }
  | { type: 'delete'; ref: FirebaseFirestore.DocumentReference };

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function commitOps(ops: WriteOp[], size = BATCH_LIMIT): Promise<void> {
  for (const part of chunk(ops, size)) {
    const batch = db().batch();
    for (const op of part) {
      if (op.type === 'set') batch.set(op.ref, op.data);
      else batch.delete(op.ref);
    }
    await batch.commit();
  }
}

/** Pure: build the Firestore doc for a Plaid transaction, keeping a hand-set category. */
export function buildTransactionDoc(
  tx: PlaidTx,
  ctx: { itemId: string; existingUserCategory?: string | null; merchantRule?: string | null; now?: string },
): TransactionDoc {
  const pfc = tx.personal_finance_category;
  const mapped = mapCategory(pfc?.primary, pfc?.detailed);
  const userCategory = ctx.existingUserCategory || null;
  const category = userCategory || ctx.merchantRule || mapped;
  return {
    itemId: ctx.itemId,
    accountId: tx.account_id,
    date: tx.date,
    month: monthOf(tx.date),
    name: tx.name,
    merchantName: tx.merchant_name ?? null,
    amount: tx.amount,
    pfcPrimary: pfc?.primary ?? null,
    pfcDetailed: pfc?.detailed ?? null,
    category,
    userCategory,
    kind: kindOf(category),
    pending: tx.pending,
    logoUrl: tx.logo_url ?? tx.personal_finance_category_icon_url ?? null,
    updatedAt: ctx.now ?? new Date().toISOString(),
  };
}

// ---- locking / debounce -------------------------------------------------

const inFlight = new Map<string, Promise<SyncResult>>();
let allInFlight: Promise<void> | null = null;
let lastManualSyncAt = 0;
export const SYNC_DEBOUNCE_MS = 60_000;

export interface SyncResult { itemId: string; status: ItemDoc['status']; added: number; modified: number; removed: number }

/** Sync one item; concurrent calls for the same item share a single run. */
export function syncItem(itemId: string): Promise<SyncResult> {
  const running = inFlight.get(itemId);
  if (running) return running;
  const p = doSyncItem(itemId).finally(() => inFlight.delete(itemId));
  inFlight.set(itemId, p);
  return p;
}

/** Sync every item, then write the net-worth snapshot. Concurrent calls share one run. */
export function syncAll(): Promise<void> {
  if (allInFlight) return allInFlight;
  allInFlight = (async () => {
    const items = await col.items().get();
    for (const doc of items.docs) await syncItem(doc.id);
    await writeSnapshot();
  })().finally(() => { allInFlight = null; });
  return allInFlight;
}

/** For POST /api/sync: returns false (skipped) if a manual sync ran within the debounce window. */
export function claimManualSync(now = Date.now()): boolean {
  if (now - lastManualSyncAt < SYNC_DEBOUNCE_MS) return false;
  lastManualSyncAt = now;
  return true;
}
export function _resetSyncState(): void {
  inFlight.clear(); allInFlight = null; lastManualSyncAt = 0;
}

// ---- the sync itself ------------------------------------------------------

async function doSyncItem(itemId: string): Promise<SyncResult> {
  const itemRef = col.items().doc(itemId);
  const snap = await itemRef.get();
  const result: SyncResult = { itemId, status: 'ok', added: 0, modified: 0, removed: 0 };
  if (!snap.exists) return result;
  const item = snap.data() as ItemDoc;

  try {
    const accessToken = await decryptToken(item.accessTokenEnc);
    const accounts = await upsertAccounts(itemId, item.institutionName, accessToken);

    const changes = await collectChanges(
      async (cursor) => (await plaid().transactionsSync({
        access_token: accessToken,
        cursor,
        count: 500,
        options: { include_personal_finance_category: true },
      })).data as unknown as SyncPage,
      item.cursor,
    );
    await applyChanges(itemId, changes);
    result.added = changes.added.length;
    result.modified = changes.modified.length;
    result.removed = changes.removed.length;

    // Cursor is saved only after all writes succeeded.
    await itemRef.set({ cursor: changes.nextCursor }, { merge: true });

    await refreshRecurring(itemId, accessToken, accounts);

    await itemRef.set({ status: 'ok', error: null, lastSyncAt: new Date().toISOString() }, { merge: true });
    result.status = 'ok';
  } catch (e) {
    logPlaidError(`sync item ${itemId}`, e);
    const code = plaidErrorCode(e);
    if (code === 'ITEM_LOGIN_REQUIRED') {
      result.status = 'login_required';
      await itemRef.set({ status: 'login_required', error: 'Login required' }, { merge: true });
    } else {
      result.status = 'error';
      await itemRef.set({ status: 'error', error: code ? `Plaid error: ${code}` : 'Sync failed' }, { merge: true });
    }
  }
  return result;
}

async function upsertAccounts(itemId: string, institutionName: string, accessToken: string): Promise<string[]> {
  const res = await plaid().accountsGet({ access_token: accessToken });
  const list: AccountBase[] = res.data.accounts;
  const refs = list.map((a) => col.accounts().doc(a.account_id));
  const existing = refs.length ? await db().getAll(...refs) : [];
  const now = new Date().toISOString();
  const ops: WriteOp[] = list.map((a, i) => {
    const prev = existing[i].exists ? (existing[i].data() as AccountDoc) : undefined;
    const data: AccountDoc = {
      itemId,
      institutionName,
      name: a.name,
      officialName: a.official_name ?? null,
      mask: a.mask ?? null,
      type: String(a.type),
      subtype: a.subtype ? String(a.subtype) : null,
      group: accountGroup(String(a.type), a.subtype ? String(a.subtype) : null),
      current: a.balances.current ?? 0,
      available: a.balances.available ?? null,
      limit: a.balances.limit ?? null,
      currency: a.balances.iso_currency_code ?? 'USD',
      hidden: prev?.hidden ?? false,
      updatedAt: now,
    };
    return { type: 'set', ref: refs[i], data };
  });
  await commitOps(ops);
  return list.map((a) => a.account_id);
}

async function loadMerchantRules(): Promise<Map<string, string>> {
  const snap = await col.merchantRules().get();
  return new Map(snap.docs.map((d) => [d.id, String(d.data().category)]));
}

async function applyChanges(itemId: string, c: Changes): Promise<void> {
  const upserts = [...c.added, ...c.modified];
  const rules = upserts.length ? await loadMerchantRules() : new Map<string, string>();
  const ops: WriteOp[] = [];

  for (const part of chunk(upserts, BATCH_LIMIT)) {
    const refs = part.map((t) => col.transactions().doc(t.transaction_id));
    const existing = await db().getAll(...refs);
    part.forEach((tx, i) => {
      const prev = existing[i].exists ? (existing[i].data() as TransactionDoc) : undefined;
      const rule = rules.get(normalizeMerchant(tx.merchant_name || tx.name)) ?? null;
      ops.push({
        type: 'set',
        ref: refs[i],
        data: buildTransactionDoc(tx, { itemId, existingUserCategory: prev?.userCategory, merchantRule: rule }),
      });
    });
  }
  for (const r of c.removed) {
    if (r.transaction_id) ops.push({ type: 'delete', ref: col.transactions().doc(r.transaction_id) });
  }
  await commitOps(ops);
}

const NOT_ENOUGH_HISTORY = new Set(['PRODUCT_NOT_READY', 'PRODUCTS_NOT_SUPPORTED', 'NO_ACCOUNTS', 'INSUFFICIENT_TRANSACTIONS']);

export function mapStream(s: any, direction: 'in' | 'out') {
  return {
    streamId: s.stream_id,
    accountId: s.account_id,
    description: s.merchant_name || s.description || 'Recurring',
    frequency: s.frequency,
    lastDate: s.last_date ?? null,
    predictedNextDate: s.predicted_next_date ?? null,
    averageAmount: Math.abs(s.average_amount?.amount ?? 0),
    isActive: s.is_active !== false,
    status: s.status ?? null,
    direction,
  };
}

async function refreshRecurring(itemId: string, accessToken: string, accountIds: string[]): Promise<void> {
  if (!accountIds.length) return;
  try {
    const res = await plaid().transactionsRecurringGet({ access_token: accessToken, account_ids: accountIds });
    await col.recurring().doc(itemId).set({
      inflow: res.data.inflow_streams.map((s) => mapStream(s, 'in')),
      outflow: res.data.outflow_streams.map((s) => mapStream(s, 'out')),
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    const code = plaidErrorCode(e);
    if (code === 'ITEM_LOGIN_REQUIRED') throw e;
    // Not enough history yet (or recurring unavailable) is not a sync failure.
    if (!code || !NOT_ENOUGH_HISTORY.has(code)) logPlaidError(`recurring ${itemId}`, e);
  }
}

// ---- net-worth snapshot -----------------------------------------------------

export interface Totals {
  netWorth: number; assets: number; liabilities: number; groups: Record<Group, number>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pure: totals over non-hidden accounts using `current` balances. */
export function computeTotals(accounts: { group: string; current: number; hidden?: boolean }[]): Totals {
  const groups = Object.fromEntries(GROUP_ORDER.map((g) => [g, 0])) as Record<Group, number>;
  let assets = 0, liabilities = 0;
  for (const a of accounts) {
    if (a.hidden) continue;
    const g = (GROUP_ORDER.includes(a.group as Group) ? a.group : 'other') as Group;
    groups[g] += a.current;
    if (LIABILITY_GROUPS.has(g)) liabilities += a.current; else assets += a.current;
  }
  for (const g of GROUP_ORDER) groups[g] = round2(groups[g]);
  return { netWorth: round2(assets - liabilities), assets: round2(assets), liabilities: round2(liabilities), groups };
}

export async function writeSnapshot(date: string = todayStr()): Promise<void> {
  const snap = await col.accounts().get();
  const accounts = snap.docs.map((d) => ({ id: d.id, ...(d.data() as AccountDoc) }));
  const totals = computeTotals(accounts);
  // Per-account balances (all accounts, hidden included) let savings goals estimate their recent rate.
  const balances = Object.fromEntries(accounts.map((a) => [a.id, a.current]));
  await col.snapshots().doc(date).set({ date, ...totals, balances });
}
