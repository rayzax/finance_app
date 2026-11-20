import { Router } from 'express';
import { z } from 'zod';
import { col, GoalDoc } from '../lib/db';
import { addDays, isDateStr, todayStr } from '../lib/dates';
import {
  RATE_WINDOW_DAYS, contributionRatePerDay, evaluateGoal, projectDate, savingsRatePerDay, summarizeGoals,
} from '../lib/goals';
import { loadAccounts, parseBody, round2 } from './util';

type GoalRow = GoalDoc & { id: string };

const dateStr = z.string().refine(isDateStr);
const name = z.string().trim().min(1).max(80);
const target = z.number().finite().positive().max(1e9);
const ids = z.array(z.string().min(1).max(128)).max(50);

const createSchema = z.object({
  name, targetAmount: target, targetDate: dateStr.nullable().optional(),
  source: z.enum(['accounts', 'manual']), accountIds: ids.optional(), countOnlyNew: z.boolean().optional(),
  manualAmount: z.number().finite().min(0).max(1e9).optional(),
}).strict();
const patchSchema = z.object({
  name: name.optional(), targetAmount: target.optional(), targetDate: dateStr.nullable().optional(),
  source: z.enum(['accounts', 'manual']).optional(), accountIds: ids.optional(), countOnlyNew: z.boolean().optional(),
  manualAmount: z.number().finite().min(0).max(1e9).optional(), archived: z.boolean().optional(),
}).strict();
const contributeSchema = z.object({
  amount: z.number().finite().refine((n) => n !== 0).refine((n) => Math.abs(n) <= 1e9), date: dateStr.optional(),
}).strict();

const manualCurrent = (g: GoalDoc) => round2((g.manualAmount ?? 0) + (g.contributions ?? []).reduce((s, c) => s + c.amount, 0));

export function goalsRouter(): Router {
  const r = Router();

  const sumBalances = (accountIds: string[], accounts: { id: string; current: number }[]) => {
    const by = new Map(accounts.map((a) => [a.id, a.current]));
    return round2(accountIds.reduce((s, id) => s + (by.get(id) ?? 0), 0));
  };

  const goalOut = (g: GoalRow, ctx: { today: string; accounts: { id: string; current: number }[]; snaps: { date: string; balances?: Record<string, number> }[] }) => {
    const accountsSource = g.source === 'accounts';
    const current = accountsSource ? round2(sumBalances(g.accountIds, ctx.accounts) - (g.startingBalance ?? 0)) : manualCurrent(g);
    const ev = evaluateGoal({
      current, targetAmount: g.targetAmount, targetDate: g.targetDate ?? null,
      createdDate: todayStr(new Date(g.createdAt)), today: ctx.today,
    });
    let rate: number | null;
    if (accountsSource) {
      // Balance history from the daily snapshots (only those written with per-account balances), plus the live value.
      const series = ctx.snaps
        .filter((s) => s.date !== ctx.today && g.accountIds.some((id) => typeof s.balances?.[id] === 'number'))
        .map((s) => ({ date: s.date, value: g.accountIds.reduce((t, id) => t + (s.balances?.[id] ?? 0), 0) - (g.startingBalance ?? 0) }));
      series.push({ date: ctx.today, value: current });
      rate = savingsRatePerDay(series, ctx.today);
    } else {
      rate = contributionRatePerDay(g.contributions ?? [], ctx.today);
    }
    return {
      id: g.id, name: g.name, targetAmount: g.targetAmount, targetDate: g.targetDate ?? null, source: g.source,
      accountIds: g.accountIds ?? [], current, pct: ev.pct, remaining: ev.remaining, monthlyNeeded: ev.monthlyNeeded,
      expectedPct: ev.expectedPct, pace: ev.pace,
      projectedDate: ev.pace === 'done' ? null : projectDate(current, g.targetAmount, rate, ctx.today),
      countOnlyNew: g.startingBalance != null, manualAmount: g.manualAmount ?? 0, createdAt: g.createdAt,
    };
  };

  const loadCtx = async () => {
    const today = todayStr();
    const [accounts, snapSnap] = await Promise.all([
      loadAccounts(),
      col.snapshots().where('date', '>=', addDays(today, -RATE_WINDOW_DAYS)).orderBy('date').get(),
    ]);
    const snaps = snapSnap.docs.map((d) => ({ date: String(d.data().date), balances: d.data().balances as Record<string, number> | undefined }));
    return { today, accounts, snaps };
  };

  /** Every linked account must exist (hidden ones are fine). */
  const missingAccount = (accountIds: string[], accounts: { id: string }[]) => {
    const have = new Set(accounts.map((a) => a.id));
    return accountIds.some((id) => !have.has(id));
  };

  r.get('/goals', async (_req, res) => {
    const [snap, ctx] = await Promise.all([col.goals().get(), loadCtx()]);
    const rows: GoalRow[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as GoalDoc) })).filter((g) => !g.archived);
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const goals = rows.map((g) => goalOut(g, ctx));
    res.json({ goals, summary: summarizeGoals(goals) });
  });

  r.post('/goals', async (req, res) => {
    const body = parseBody(createSchema, req, res);
    if (!body) return;
    const accounts = await loadAccounts();
    const accountIds = body.source === 'accounts' ? [...new Set(body.accountIds ?? [])] : [];
    if (body.source === 'accounts' && (!accountIds.length || missingAccount(accountIds, accounts))) {
      res.status(400).json({ error: 'Choose at least one linked account' });
      return;
    }
    const doc: GoalDoc = {
      name: body.name, targetAmount: round2(body.targetAmount), targetDate: body.targetDate ?? null, source: body.source,
      accountIds, startingBalance: body.source === 'accounts' && body.countOnlyNew ? sumBalances(accountIds, accounts) : null,
      manualAmount: body.source === 'manual' ? round2(body.manualAmount ?? 0) : 0, contributions: [],
      createdAt: new Date().toISOString(), archived: false,
    };
    const ref = await col.goals().add(doc);
    res.status(201).json(goalOut({ id: ref.id, ...doc }, { today: todayStr(), accounts, snaps: [] }));
  });

  r.patch('/goals/:id', async (req, res) => {
    const body = parseBody(patchSchema, req, res);
    if (!body) return;
    const ref = col.goals().doc(String(req.params.id));
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ error: 'Goal not found' }); return; }
    const old = snap.data() as GoalDoc;
    const accounts = await loadAccounts();
    const next: GoalDoc = { ...old, contributions: old.contributions ?? [] };
    if (body.name !== undefined) next.name = body.name;
    if (body.targetAmount !== undefined) next.targetAmount = round2(body.targetAmount);
    if (body.targetDate !== undefined) next.targetDate = body.targetDate;
    if (body.archived !== undefined) next.archived = body.archived;
    if (body.source !== undefined) next.source = body.source;
    if (body.manualAmount !== undefined) next.manualAmount = round2(body.manualAmount);
    if (body.accountIds !== undefined) next.accountIds = [...new Set(body.accountIds)];
    if (next.source === 'accounts') {
      if (!next.accountIds.length || missingAccount(next.accountIds, accounts)) {
        res.status(400).json({ error: 'Choose at least one linked account' });
        return;
      }
      const wasOnlyNew = old.source === 'accounts' && old.startingBalance != null;
      const wantOnlyNew = body.countOnlyNew ?? wasOnlyNew;
      const accountsChanged = old.source !== 'accounts' || next.accountIds.slice().sort().join() !== (old.accountIds ?? []).slice().sort().join();
      // Re-capture the baseline when it is switched on or the linked accounts change; keep it otherwise.
      next.startingBalance = !wantOnlyNew ? null : wasOnlyNew && !accountsChanged ? old.startingBalance : sumBalances(next.accountIds, accounts);
    } else {
      next.accountIds = [];
      next.startingBalance = null;
    }
    await ref.set(next);
    res.json(goalOut({ id: ref.id, ...next }, { today: todayStr(), accounts, snaps: [] }));
  });

  r.delete('/goals/:id', async (req, res) => {
    const ref = col.goals().doc(String(req.params.id));
    if (!(await ref.get()).exists) { res.status(404).json({ error: 'Goal not found' }); return; }
    await ref.delete();
    res.json({ ok: true });
  });

  r.post('/goals/:id/contribute', async (req, res) => {
    const body = parseBody(contributeSchema, req, res);
    if (!body) return;
    const ref = col.goals().doc(String(req.params.id));
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ error: 'Goal not found' }); return; }
    const g = snap.data() as GoalDoc;
    if (g.source !== 'manual') { res.status(400).json({ error: 'Only manual goals take contributions' }); return; }
    const today = todayStr();
    const contributions = [...(g.contributions ?? []), { date: body.date ?? today, amount: round2(body.amount) }];
    if (manualCurrent({ ...g, contributions }) < 0) { res.status(400).json({ error: 'Withdrawal is more than the saved amount' }); return; }
    await ref.set({ contributions }, { merge: true });
    res.json(goalOut({ id: ref.id, ...g, contributions }, { today, accounts: [], snaps: [] }));
  });

  return r;
}
