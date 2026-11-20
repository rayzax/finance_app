import { Router } from 'express';
import { z } from 'zod';
import { col, RecurringCostDoc, TransactionDoc } from '../lib/db';
import { SPEND_CATEGORIES, categoryLabel, normalizeMerchant } from '../lib/categories';
import { isMonth, monthOf, todayStr } from '../lib/dates';
import { Stream } from '../lib/forecast';
import { costKey, dueDateIn, findPayment, merchantMatches, statusFor, PaymentTx } from '../lib/recurringCosts';
import { loadAccounts, parseBody, round2 } from './util';

type CostRow = RecurringCostDoc & { id: string };

const costOut = (c: CostRow) => ({
  id: c.id, name: c.name, amount: c.amount, dayOfMonth: c.dayOfMonth, category: c.category,
  categoryLabel: categoryLabel(c.category), matchMerchant: c.matchMerchant ?? null, active: c.active,
});

/** Costs with their paid / due / overdue status for `month`. Shared by the list endpoint and the cash-flow forecast. */
export async function loadCostsForMonth(month: string, today: string) {
  const [costSnap, txSnap] = await Promise.all([
    col.recurringCosts().get(),
    col.transactions().where('month', '==', month).get(),
  ]);
  const txs: PaymentTx[] = txSnap.docs.map((d) => {
    const t = d.data() as TransactionDoc;
    return { id: d.id, date: t.date, amount: t.amount, merchantName: t.merchantName, name: t.name };
  });
  const rows: CostRow[] = costSnap.docs.map((d) => ({ id: d.id, ...(d.data() as RecurringCostDoc) }));
  const items = rows.map((c) => {
    const dueDate = dueDateIn(month, c.dayOfMonth);
    const paidTx = findPayment(c, txs);
    return {
      ...costOut(c), dueDate, status: statusFor(dueDate, today, !!paidTx),
      paidTxId: paidTx?.id ?? null, paidDate: paidTx?.date ?? null,
    };
  }).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
  return { rows, items };
}

const name = z.string().trim().min(1).max(80);
const amount = z.number().finite().positive().max(1e7);
const day = z.number().int().min(1).max(31);
const category = z.string().refine((k) => SPEND_CATEGORIES.some((c) => c.key === k));
const merchant = z.string().trim().max(100).nullable();
const normMerchant = (m: string | null | undefined) => (m ? normalizeMerchant(m) || null : null);

const createSchema = z.object({
  name, amount, dayOfMonth: day, category: category.default('bills'),
  matchMerchant: merchant.optional(), active: z.boolean().optional(),
}).strict();
const patchSchema = z.object({
  name: name.optional(), amount: amount.optional(), dayOfMonth: day.optional(), category: category.optional(),
  matchMerchant: merchant.optional(), active: z.boolean().optional(),
}).strict();

export function recurringCostsRouter(): Router {
  const r = Router();

  r.get('/recurring-costs', async (req, res) => {
    const today = todayStr();
    const month = req.query.month ? String(req.query.month) : monthOf(today);
    if (!isMonth(month)) { res.status(400).json({ error: 'Invalid month' }); return; }
    const [{ items }, recSnap, accounts] = await Promise.all([loadCostsForMonth(month, today), col.recurring().get(), loadAccounts()]);

    const active = items.filter((i) => i.active);
    const paid = active.filter((i) => i.status === 'paid');
    const unpaid = active.filter((i) => i.status !== 'paid');
    const sum = (l: { amount: number }[]) => round2(l.reduce((s, i) => s + i.amount, 0));

    // Plaid outflow streams that are not already tracked.
    const hidden = new Set(accounts.filter((a) => a.hidden).map((a) => a.id));
    const keys = items.flatMap((i) => [costKey(i), normalizeMerchant(i.name)]).filter(Boolean);
    const detected: { streamId: string; description: string; averageAmount: number; frequency: string; predictedNextDate: string | null; lastDate: string | null }[] = [];
    const seen = new Set<string>();
    for (const d of recSnap.docs) {
      for (const s of ((d.data() as { outflow?: (Stream & { accountId?: string })[] }).outflow ?? [])) {
        if (s.isActive === false || s.status === 'TOMBSTONED' || !(s.averageAmount > 0)) continue;
        if (s.accountId && hidden.has(s.accountId)) continue;
        const norm = normalizeMerchant(s.description);
        if (!norm || keys.some((k) => merchantMatches(norm, k))) continue;
        const id = s.streamId ?? `${d.id}:${norm}`;
        if (seen.has(id)) continue;
        seen.add(id);
        detected.push({
          streamId: id, description: s.description, averageAmount: round2(s.averageAmount), frequency: s.frequency,
          predictedNextDate: s.predictedNextDate ?? null, lastDate: s.lastDate ?? null,
        });
      }
    }
    detected.sort((a, b) => b.averageAmount - a.averageAmount);

    res.json({
      month, totalMonthly: sum(active), paidCount: paid.length, paidAmount: sum(paid),
      upcomingCount: unpaid.length, upcomingAmount: sum(unpaid), items, detected,
    });
  });

  r.post('/recurring-costs', async (req, res) => {
    const body = parseBody(createSchema, req, res);
    if (!body) return;
    const now = new Date().toISOString();
    const doc: RecurringCostDoc = {
      name: body.name, amount: round2(body.amount), dayOfMonth: body.dayOfMonth, category: body.category,
      matchMerchant: normMerchant(body.matchMerchant), active: body.active ?? true, createdAt: now, updatedAt: now,
    };
    const ref = await col.recurringCosts().add(doc);
    res.status(201).json(costOut({ id: ref.id, ...doc }));
  });

  r.patch('/recurring-costs/:id', async (req, res) => {
    const body = parseBody(patchSchema, req, res);
    if (!body) return;
    const ref = col.recurringCosts().doc(String(req.params.id));
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ error: 'Recurring cost not found' }); return; }
    const patch: Partial<RecurringCostDoc> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.amount !== undefined) patch.amount = round2(body.amount);
    if (body.dayOfMonth !== undefined) patch.dayOfMonth = body.dayOfMonth;
    if (body.category !== undefined) patch.category = body.category;
    if (body.matchMerchant !== undefined) patch.matchMerchant = normMerchant(body.matchMerchant);
    if (body.active !== undefined) patch.active = body.active;
    await ref.set(patch, { merge: true });
    res.json(costOut({ id: ref.id, ...((await ref.get()).data() as RecurringCostDoc) }));
  });

  r.delete('/recurring-costs/:id', async (req, res) => {
    const ref = col.recurringCosts().doc(String(req.params.id));
    if (!(await ref.get()).exists) { res.status(404).json({ error: 'Recurring cost not found' }); return; }
    await ref.delete();
    res.json({ ok: true });
  });

  return r;
}
