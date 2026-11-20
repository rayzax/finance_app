import { Router } from 'express';
import { FieldPath } from '@google-cloud/firestore';
import { z } from 'zod';
import { col, db, deleteQuery, AccountDoc, ItemDoc, TransactionDoc } from '../lib/db';
import {
  CATEGORIES, GROUP_LABELS, GROUP_ORDER, SPEND_CATEGORIES, categoryLabel, isCategoryKey, kindOf, normalizeMerchant, Group,
} from '../lib/categories';
import { addDays, dayLabel, daysLeftInMonth, isMonth, monthOf, rangeLabel, rangeStart, todayStr, Range } from '../lib/dates';
import { buildForecast, Stream } from '../lib/forecast';
import { computeTotals, writeSnapshot } from '../lib/sync';
import { logPlaidError, plaid, plaidErrorCode } from '../lib/plaid';
import { decryptToken } from '../lib/crypto';
import { loadAccounts, parseBody, round2 } from './util';
import { loadCostsForMonth } from './recurringCosts';
import { latestSyncAt } from './sync';

export function dataRouter(): Router {
  const r = Router();

  r.get('/categories', (_req, res) => {
    res.json(CATEGORIES.map(({ key, label }) => ({ key, label })));
  });

  // ---- summary ----
  r.get('/summary', async (req, res) => {
    const q = String(req.query.range ?? '1M').toUpperCase();
    const range: Range = (['1M', '3M', '1Y', 'ALL'] as const).includes(q as Range) ? (q as Range) : '1M';
    const today = todayStr();
    const start = rangeStart(range, today);
    const [accounts, snaps, lastSyncAt] = await Promise.all([
      loadAccounts(),
      (start ? col.snapshots().where('date', '>=', start) : col.snapshots()).orderBy('date').get(),
      latestSyncAt(),
    ]);
    const totals = computeTotals(accounts);
    const series = snaps.docs
      .map((d) => ({ date: String(d.data().date), value: Number(d.data().netWorth) }))
      .filter((p) => p.date !== today);
    series.push({ date: today, value: totals.netWorth }); // live value for today
    const delta = series.length > 1 ? round2(series[series.length - 1].value - series[0].value) : 0;

    const visible = accounts.filter((a) => !a.hidden);
    const groups = GROUP_ORDER.map((g) => {
      const list = visible.filter((a) => a.group === g);
      const insts = [...new Set(list.map((a) => a.institutionName))];
      return {
        group: g, label: GROUP_LABELS[g], total: totals.groups[g], count: list.length,
        subtitle: insts.length && insts.length <= 2 ? insts.join(', ') : `${list.length} account${list.length === 1 ? '' : 's'}`,
      };
    }).filter((g) => g.count > 0);

    res.json({
      netWorth: totals.netWorth, assets: totals.assets, liabilities: totals.liabilities,
      delta, deltaLabel: rangeLabel(range), series, groups, lastSyncAt, hasAccounts: accounts.length > 0,
    });
  });

  // ---- accounts ----
  const accountOut = (a: AccountDoc & { id: string }) => ({
    id: a.id, itemId: a.itemId, institutionName: a.institutionName, name: a.name, officialName: a.officialName,
    mask: a.mask, type: a.type, subtype: a.subtype, group: a.group as Group, current: a.current,
    available: a.available, limit: a.limit, currency: a.currency, hidden: !!a.hidden,
  });

  r.get('/accounts', async (_req, res) => {
    const [accounts, itemsSnap] = await Promise.all([loadAccounts(), col.items().get()]);
    const groups = GROUP_ORDER.map((g) => {
      const list = accounts
        .filter((a) => a.group === g)
        .sort((a, b) => a.institutionName.localeCompare(b.institutionName) || a.name.localeCompare(b.name));
      return {
        group: g, label: GROUP_LABELS[g],
        total: round2(list.filter((a) => !a.hidden).reduce((s, a) => s + a.current, 0)),
        accounts: list.map(accountOut),
      };
    }).filter((g) => g.accounts.length > 0);
    const items = itemsSnap.docs.map((d) => {
      const i = d.data() as ItemDoc; // accessTokenEnc deliberately not returned
      return {
        id: d.id, institutionName: i.institutionName, status: i.status, error: i.error ?? null,
        lastSyncAt: i.lastSyncAt ?? null, newAccountsAvailable: !!i.newAccountsAvailable,
      };
    });
    res.json({ groups, items });
  });

  r.patch('/accounts/:id', async (req, res) => {
    const body = parseBody(z.object({ hidden: z.boolean() }).strict(), req, res);
    if (!body) return;
    const ref = col.accounts().doc(String(req.params.id));
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ error: 'Account not found' }); return; }
    await ref.set({ hidden: body.hidden, updatedAt: new Date().toISOString() }, { merge: true });
    await writeSnapshot();
    res.json(accountOut({ id: ref.id, ...((await ref.get()).data() as AccountDoc) }));
  });

  // ---- transactions ----
  type TxDoc = TransactionDoc & { id: string };
  const txOut = (t: TxDoc, names: Map<string, string>) => ({
    id: t.id, date: t.date, name: t.name, merchantName: t.merchantName, amount: t.amount, category: t.category,
    categoryLabel: categoryLabel(t.category), kind: t.kind, pending: t.pending, logoUrl: t.logoUrl,
    accountId: t.accountId, accountName: names.get(t.accountId) ?? '', userCategory: !!t.userCategory,
  });

  r.get('/transactions', async (req, res) => {
    const kind = ['spend', 'income', 'transfer'].includes(String(req.query.kind)) ? String(req.query.kind) : undefined;
    const needle = String(req.query.q ?? '').trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const before = typeof req.query.before === 'string' && /^\d{4}-\d{2}-\d{2}\|[^/]+$/.test(req.query.before) ? req.query.before : undefined;
    const today = todayStr();
    const month = monthOf(today);

    const accounts = await loadAccounts();
    const hidden = new Set(accounts.filter((a) => a.hidden).map((a) => a.id));
    const names = new Map(accounts.map((a) => [a.id, a.name]));

    let base: FirebaseFirestore.Query = col.transactions();
    if (kind) base = base.where('kind', '==', kind);
    base = base.orderBy('date', 'desc').orderBy(FieldPath.documentId(), 'desc');
    let cursor = before ? before.split('|') : undefined;

    const picked: TxDoc[] = [];
    let more = false;
    const pageSize = needle ? 500 : limit + 21;
    for (let i = 0; i < 40 && !more; i++) {
      const q = cursor ? base.startAfter(cursor[0], cursor[1]).limit(pageSize) : base.limit(pageSize);
      const snap = await q.get();
      for (const d of snap.docs) {
        const t = { id: d.id, ...(d.data() as TransactionDoc) };
        if (hidden.has(t.accountId)) continue;
        if (needle && !`${t.name} ${t.merchantName ?? ''} ${categoryLabel(t.category)}`.toLowerCase().includes(needle)) continue;
        if (picked.length === limit) { more = true; break; }
        picked.push(t);
      }
      if (snap.size < pageSize) break;
      const last = snap.docs[snap.docs.length - 1];
      cursor = [String(last.data().date), last.id];
    }

    const days: { date: string; label: string; items: ReturnType<typeof txOut>[] }[] = [];
    for (const t of picked) {
      let day = days[days.length - 1];
      if (!day || day.date !== t.date) { day = { date: t.date, label: dayLabel(t.date, today), items: [] }; days.push(day); }
      day.items.push(txOut(t, names));
    }
    const lastPicked = picked[picked.length - 1];
    const nextCursor = more && lastPicked ? `${lastPicked.date}|${lastPicked.id}` : null;

    // Month totals (refunds reduce spending; income amounts are negative in Plaid's sign).
    const mSnap = await col.transactions().where('month', '==', month).get();
    let monthSpent = 0, monthEarned = 0;
    for (const d of mSnap.docs) {
      const t = d.data() as TransactionDoc;
      if (hidden.has(t.accountId)) continue;
      if (t.kind === 'spend') monthSpent += t.amount;
      else if (t.kind === 'income') monthEarned -= t.amount;
    }
    res.json({ days, nextCursor, monthSpent: round2(monthSpent), monthEarned: round2(monthEarned), month });
  });

  r.patch('/transactions/:id', async (req, res) => {
    const body = parseBody(
      z.object({ category: z.string().refine(isCategoryKey), applyToMerchant: z.boolean().optional() }).strict(), req, res);
    if (!body) return;
    const ref = col.transactions().doc(String(req.params.id));
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ error: 'Transaction not found' }); return; }
    const t = snap.data() as TransactionDoc;
    await ref.set({ category: body.category, userCategory: body.category, kind: kindOf(body.category), updatedAt: new Date().toISOString() }, { merge: true });
    if (body.applyToMerchant) {
      const id = normalizeMerchant(t.merchantName || t.name);
      if (id) await col.merchantRules().doc(id).set({ category: body.category, updatedAt: new Date().toISOString() });
    }
    const accounts = await loadAccounts();
    const names = new Map(accounts.map((a) => [a.id, a.name]));
    res.json(txOut({ id: ref.id, ...((await ref.get()).data() as TransactionDoc) }, names));
  });

  r.get('/transactions.csv', async (req, res) => {
    const month = String(req.query.month ?? monthOf(todayStr()));
    if (!isMonth(month)) { res.status(400).json({ error: 'Invalid month' }); return; }
    const [snap, accounts] = await Promise.all([
      col.transactions().where('month', '==', month).orderBy('date', 'desc').get(), loadAccounts(),
    ]);
    const names = new Map(accounts.map((a) => [a.id, a.name]));
    // Neutralise spreadsheet formula injection in text cells.
    const cell = (v: unknown) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['Date,Name,Merchant,Category,Amount,Account,Pending'];
    for (const d of snap.docs) {
      const t = d.data() as TransactionDoc;
      lines.push([t.date, cell(t.name), cell(t.merchantName), cell(categoryLabel(t.category)), t.amount.toFixed(2), cell(names.get(t.accountId)), t.pending ? 'yes' : 'no'].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reserve-${month}.csv"`);
    res.send(lines.join('\n') + '\n');
  });

  // ---- budgets ----
  const loadLimits = async (): Promise<Record<string, number>> => {
    const s = await col.settings().doc('budgets').get();
    return (s.exists ? (s.data()?.limits as Record<string, number>) : undefined) ?? {};
  };

  r.get('/budgets', async (req, res) => {
    const today = todayStr();
    const month = req.query.month ? String(req.query.month) : monthOf(today);
    if (!isMonth(month)) { res.status(400).json({ error: 'Invalid month' }); return; }
    const [limits, snap, accounts] = await Promise.all([
      loadLimits(), col.transactions().where('month', '==', month).where('kind', '==', 'spend').get(), loadAccounts(),
    ]);
    const hidden = new Set(accounts.filter((a) => a.hidden).map((a) => a.id));
    const spentBy: Record<string, number> = {};
    for (const d of snap.docs) {
      const t = d.data() as TransactionDoc;
      if (hidden.has(t.accountId)) continue;
      spentBy[t.category] = (spentBy[t.category] ?? 0) + t.amount;
    }
    const categories = SPEND_CATEGORIES
      .map((c) => {
        const limit = limits[c.key] ?? 0;
        const spent = Math.max(0, round2(spentBy[c.key] ?? 0));
        return { key: c.key, label: c.label, limit, spent, over: limit > 0 && spent > limit };
      })
      .filter((c) => c.limit > 0 || c.spent > 0)
      .sort((a, b) => b.spent - a.spent);
    const limit = round2(categories.reduce((s, c) => s + c.limit, 0));
    // Overall spent only counts categories that have a limit, so it is comparable with `limit`.
    const spent = round2(categories.filter((c) => c.limit > 0).reduce((s, c) => s + c.spent, 0));
    res.json({
      limit, spent, left: round2(limit - spent), pct: limit > 0 ? Math.round((spent / limit) * 100) : 0,
      daysLeft: daysLeftInMonth(month, today), categories,
    });
  });

  r.put('/budgets', async (req, res) => {
    const schema = z.object({
      limits: z.record(z.string(), z.number().finite().min(0).max(1e9))
        .refine((o) => Object.keys(o).every((k) => SPEND_CATEGORIES.some((c) => c.key === k))),
    }).strict();
    const body = parseBody(schema, req, res);
    if (!body) return;
    await col.settings().doc('budgets').set({ limits: body.limits, updatedAt: new Date().toISOString() });
    res.json({ ok: true });
  });

  // ---- cashflow ----
  r.get('/cashflow', async (_req, res) => {
    const asOf = todayStr();
    const [accounts, recSnap, snaps, costs] = await Promise.all([
      loadAccounts(), col.recurring().get(), col.snapshots().where('date', '>=', addDays(asOf, -35)).orderBy('date').get(),
      loadCostsForMonth(monthOf(asOf), asOf),
    ]);
    const manualCosts = costs.items.filter((c) => c.active).map((c) => ({
      name: c.name, amount: c.amount, dayOfMonth: c.dayOfMonth, matchMerchant: c.matchMerchant, paidThisMonth: c.status === 'paid',
    }));
    const cashNow = accounts.filter((a) => a.group === 'cash' && !a.hidden).reduce((s, a) => s + a.current, 0);
    const hiddenIds = new Set(accounts.filter((a) => a.hidden).map((a) => a.id));
    const streams: Stream[] = [];
    for (const d of recSnap.docs) {
      const data = d.data() as { inflow?: Stream[]; outflow?: Stream[] };
      for (const s of [...(data.inflow ?? []), ...(data.outflow ?? [])]) {
        if (!hiddenIds.has((s as any).accountId)) streams.push(s);
      }
    }
    const cashHistory = snaps.docs.map((d) => ({ date: String(d.data().date), cash: Number(d.data().groups?.cash ?? 0) }));
    res.json(buildForecast({ cashNow, streams, manualCosts, asOf, cashHistory }));
  });

  // ---- items ----
  r.delete('/items/:id', async (req, res) => {
    const id = String(req.params.id);
    const ref = col.items().doc(id);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ error: 'Item not found' }); return; }
    try {
      await plaid().itemRemove({ access_token: await decryptToken((snap.data() as ItemDoc).accessTokenEnc) });
    } catch (e) {
      if (plaidErrorCode(e) !== 'ITEM_NOT_FOUND') {
        logPlaidError(`remove item ${id}`, e);
        res.status(502).json({ error: 'Could not remove item at Plaid' });
        return;
      }
    }
    await deleteQuery(col.accounts().where('itemId', '==', id));
    await deleteQuery(col.transactions().where('itemId', '==', id));
    await col.recurring().doc(id).delete();
    await ref.delete();
    await writeSnapshot();
    res.json({ ok: true });
  });

  return r;
}
