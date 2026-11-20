import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { hashPassword, MAX_PASSWORD_BYTES, passwordTooLong, type AuthMiddleware } from '../lib/auth';
import {
  deriveInitials, newUserDoc, normalizeUsername, toPublicUser, USERNAME_RE, UsernameTakenError,
  type Role, type StoredUser, type UserDoc, type UserStore,
} from '../lib/users';
import { parseBody } from './util';

export interface UsersRouterDeps {
  store: UserStore;
  mw: AuthMiddleware;
  now: () => number;
  bcryptCost?: number;
}

const tempPassword = z.string().min(12).max(1024);
const createSchema = z.object({
  username: z.string().transform(normalizeUsername).pipe(z.string().regex(USERNAME_RE)),
  displayName: z.string().trim().min(1).max(60),
  role: z.enum(['admin', 'member']),
  temporaryPassword: tempPassword,
}).strict();
const patchSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  role: z.enum(['admin', 'member']).optional(),
  disabled: z.boolean().optional(),
}).strict();
const resetPwSchema = z.object({ temporaryPassword: tempPassword }).strict();

export const GUARD_MESSAGES: Record<string, string> = {
  self: 'You cannot do that to your own account',
  last_admin: 'There must be at least one active admin',
};

/**
 * Pure guard shared by PATCH and DELETE. `change` describes the target after the operation.
 * - An admin may not delete, disable or demote themselves.
 * - The last active admin may not be removed, disabled or demoted.
 */
export function adminGuard(
  actorId: string, target: StoredUser, activeAdminIds: string[],
  change: { remove?: boolean; disable?: boolean; demote?: boolean },
): 'self' | 'last_admin' | null {
  const losesAdmin = Boolean(change.remove || (change.disable && !target.disabled) || (change.demote && target.role === 'admin'));
  if (!losesAdmin) return null;
  if (target.id === actorId) return 'self';
  if (target.role === 'admin' && !target.disabled && activeAdminIds.length <= 1 && activeAdminIds.includes(target.id)) return 'last_admin';
  return null;
}

export function usersRouter(deps: UsersRouterDeps): Router {
  const { store, mw, now } = deps;
  const r = Router();
  const actor = (req: Request) => ({ actorId: req.user!.id, actorUsername: req.user!.username, ip: req.ip ?? null });
  const notFound = (res: Response) => res.status(404).json({ error: 'Not found' });
  const pwError = (res: Response) => res.status(400).json({ error: `Password must be at most ${MAX_PASSWORD_BYTES} bytes` });

  const reject = (res: Response, reason: string) => {
    if (reason === 'not_found') return notFound(res);
    const msg = GUARD_MESSAGES[reason];
    if (msg) return res.status(400).json({ error: msg });
    return res.status(409).json({ error: 'Conflict, try again' });
  };

  r.get('/', async (_req, res) => {
    res.json({ users: (await store.list()).map(toPublicUser) });
  });

  r.post('/', async (req, res) => {
    const body = parseBody(createSchema, req, res);
    if (!body) return;
    if (passwordTooLong(body.temporaryPassword)) return void pwError(res);
    try {
      const user = await store.create(newUserDoc({
        username: body.username, displayName: body.displayName, role: body.role,
        passwordHash: await hashPassword(body.temporaryPassword, deps.bcryptCost),
        mustChangePassword: true, createdBy: req.user!.id, now: new Date(now()),
      }));
      audit('user_created', { ...actor(req), userId: user.id, username: user.username, changes: [`role:${user.role}`] });
      res.status(201).json(toPublicUser(user));
    } catch (e) {
      if (e instanceof UsernameTakenError) {
        res.status(409).json({ error: 'That username is taken' });
        return;
      }
      throw e;
    }
  });

  r.patch('/:id', async (req, res) => {
    const body = parseBody(patchSchema, req, res);
    if (!body) return;
    const id = String(req.params.id);
    const out = await store.mutate(id, (u, admins) => {
      const guard = adminGuard(req.user!.id, u, admins, {
        demote: body.role === 'member', disable: body.disabled === true,
      });
      if (guard) return { abort: guard };
      const patch: Partial<UserDoc> = {};
      if (body.displayName !== undefined) {
        patch.displayName = body.displayName;
        patch.initials = deriveInitials(body.displayName);
      }
      if (body.role !== undefined) patch.role = body.role as Role;
      if (body.disabled !== undefined) {
        patch.disabled = body.disabled;
        if (body.disabled && !u.disabled) patch.sessionVersion = u.sessionVersion + 1; // re-enabling must not revive old sessions
      }
      return { patch };
    });
    mw.invalidate(id);
    if (!out.ok) return void reject(res, out.reason);
    audit('user_updated', { ...actor(req), userId: id, username: out.user!.username, changes: Object.keys(body) });
    res.json(toPublicUser(out.user!));
  });

  r.post('/:id/reset-password', async (req, res) => {
    const body = parseBody(resetPwSchema, req, res);
    if (!body) return;
    if (passwordTooLong(body.temporaryPassword)) return void pwError(res);
    const id = String(req.params.id);
    const passwordHash = await hashPassword(body.temporaryPassword, deps.bcryptCost);
    const out = await store.mutate(id, (u) => ({
      patch: {
        passwordHash, mustChangePassword: true, sessionVersion: u.sessionVersion + 1,
        failedLogins: 0, failedWindowStart: null, lockedUntil: null,
      },
    }));
    mw.invalidate(id);
    if (!out.ok) return void reject(res, out.reason);
    audit('user_password_reset', { ...actor(req), userId: id, username: out.user!.username });
    res.json({ ok: true });
  });

  r.post('/:id/reset-mfa', async (req, res) => {
    const id = String(req.params.id);
    const out = await store.mutate(id, (u) => ({
      patch: {
        totpSecretEnc: null, totpPendingEnc: null, totpEnabled: false, totpLastStep: 0, recoveryCodes: [],
        sessionVersion: u.sessionVersion + 1, failedLogins: 0, failedWindowStart: null, lockedUntil: null,
      },
    }));
    mw.invalidate(id);
    if (!out.ok) return void reject(res, out.reason);
    audit('user_mfa_reset', { ...actor(req), userId: id, username: out.user!.username });
    res.json({ ok: true });
  });

  r.delete('/:id', async (req, res) => {
    const id = String(req.params.id);
    let username = '';
    const out = await store.mutate(id, (u, admins) => {
      const guard = adminGuard(req.user!.id, u, admins, { remove: true });
      if (guard) return { abort: guard };
      username = u.username;
      return { delete: true };
    });
    mw.invalidate(id);
    if (!out.ok) return void reject(res, out.reason);
    audit('user_deleted', { ...actor(req), userId: id, username });
    res.json({ ok: true });
  });

  return r;
}
