import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import { col, AccountDoc } from '../lib/db';

/** Parse a request body with zod; on failure respond 400 and return undefined. */
export function parseBody<T>(schema: ZodType<T>, req: Request, res: Response): T | undefined {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) {
    res.status(400).json({ error: 'Invalid request' });
    return undefined;
  }
  return r.data;
}

export async function loadAccounts(): Promise<(AccountDoc & { id: string })[]> {
  const snap = await col.accounts().get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as AccountDoc) }));
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
