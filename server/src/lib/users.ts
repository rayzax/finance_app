import { randomBytes } from 'node:crypto';
import { col, db } from './db';

export type Role = 'admin' | 'member';

/** `users/{userId}`. Timestamps are ISO strings, like the rest of the data model. */
export interface UserDoc {
  username: string;
  displayName: string;
  initials: string;
  passwordHash: string;
  role: Role;
  /** Encrypted (KMS in prod, AES-GCM in dev) base32 TOTP secret; null until enrolled. */
  totpSecretEnc: string | null;
  /** Secret generated during enrollment, not yet proven by a code. Promoted on enable. */
  totpPendingEnc: string | null;
  totpEnabled: boolean;
  /** Time step of the last accepted TOTP code (replay protection). */
  totpLastStep: number;
  /** sha256 hex of each unused recovery code. */
  recoveryCodes: string[];
  mustChangePassword: boolean;
  /** Bump to revoke every session and pending token of this user. */
  sessionVersion: number;
  disabled: boolean;
  failedLogins: number;
  failedWindowStart: string | null;
  lockedUntil: string | null;
  createdAt: string;
  createdBy: string | null;
  lastLoginAt: string | null;
}

export type StoredUser = UserDoc & { id: string };

/** Safe to send to the browser: no hash, secret or recovery material. */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  initials: string;
  role: Role;
}

export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

export function normalizeUsername(u: string): string {
  return u.trim().toLowerCase();
}

/** Up to two letters: first letters of the first and last word (or the first two letters of a single word). */
export function deriveInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const letters = (w: string) => Array.from(w).filter((c) => /\p{L}/u.test(c));
  let out = '';
  if (words.length >= 2) out = (letters(words[0])[0] ?? '') + (letters(words[words.length - 1])[0] ?? '');
  else if (words.length === 1) out = letters(words[0]).slice(0, 2).join('');
  return out.toUpperCase() || '?';
}

export function toAuthUser(u: StoredUser): AuthUser {
  return { id: u.id, username: u.username, displayName: u.displayName, initials: u.initials, role: u.role };
}

/** Admin-facing listing row. Deliberately an allow-list. */
export function toPublicUser(u: StoredUser) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    totpEnabled: u.totpEnabled,
    disabled: u.disabled,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

export function newUserDoc(init: {
  username: string;
  displayName: string;
  role: Role;
  passwordHash: string;
  mustChangePassword: boolean;
  createdBy: string | null;
  now: Date;
}): UserDoc {
  return {
    username: init.username,
    displayName: init.displayName,
    initials: deriveInitials(init.displayName),
    passwordHash: init.passwordHash,
    role: init.role,
    totpSecretEnc: null,
    totpPendingEnc: null,
    totpEnabled: false,
    totpLastStep: 0,
    recoveryCodes: [],
    mustChangePassword: init.mustChangePassword,
    sessionVersion: 1,
    disabled: false,
    failedLogins: 0,
    failedWindowStart: null,
    lockedUntil: null,
    createdAt: init.now.toISOString(),
    createdBy: init.createdBy,
    lastLoginAt: null,
  };
}

export class UsernameTakenError extends Error {
  constructor() {
    super('username_taken');
  }
}

export type MutateDecision = { patch: Partial<UserDoc> } | { delete: true } | { abort: string };
export type MutateResult =
  | { ok: true; user: StoredUser | null }
  | { ok: false; reason: string };

/**
 * Persistence for users. `mutate` is the single atomic read-modify-write primitive: every security-relevant
 * change (TOTP replay claim, recovery-code consumption, failure counters, last-admin guard) goes through it.
 */
export interface UserStore {
  isEmpty(): Promise<boolean>;
  getById(id: string): Promise<StoredUser | undefined>;
  getByUsername(username: string): Promise<StoredUser | undefined>;
  list(): Promise<StoredUser[]>;
  /** Throws UsernameTakenError. */
  create(doc: UserDoc): Promise<StoredUser>;
  /**
   * Atomically read the user, decide, and write. `fn` is synchronous and may run more than once (transaction retry),
   * so it must be pure. `activeAdminIds` lists non-disabled admins as seen in the same transaction.
   * Resolves `{ok:false, reason:'not_found'}` for a missing user, or the reason given by `{abort}`.
   * For `{delete:true}` the result is `{ok:true, user:null}`.
   */
  mutate(id: string, fn: (u: StoredUser, activeAdminIds: string[]) => MutateDecision): Promise<MutateResult>;
}

const toStored = (d: FirebaseFirestore.DocumentSnapshot): StoredUser => ({ id: d.id, ...(d.data() as UserDoc) });
const isActiveAdmin = (u: UserDoc) => u.role === 'admin' && !u.disabled;

export class FirestoreUserStore implements UserStore {
  async isEmpty(): Promise<boolean> {
    return (await col.users().limit(1).get()).empty;
  }

  async getById(id: string): Promise<StoredUser | undefined> {
    const d = await col.users().doc(id).get();
    return d.exists ? toStored(d) : undefined;
  }

  async getByUsername(username: string): Promise<StoredUser | undefined> {
    const n = await col.usernames().doc(username).get();
    const id = n.exists ? (n.data() as { userId?: string }).userId : undefined;
    return id ? this.getById(id) : undefined;
  }

  async list(): Promise<StoredUser[]> {
    const snap = await col.users().get();
    return snap.docs.map(toStored).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(doc: UserDoc): Promise<StoredUser> {
    const id = randomBytes(12).toString('hex');
    await db().runTransaction(async (tx) => {
      const nameRef = col.usernames().doc(doc.username);
      if ((await tx.get(nameRef)).exists) throw new UsernameTakenError();
      tx.set(nameRef, { userId: id });
      tx.set(col.users().doc(id), doc);
    });
    return { id, ...doc };
  }

  async mutate(id: string, fn: (u: StoredUser, activeAdminIds: string[]) => MutateDecision): Promise<MutateResult> {
    return db().runTransaction(async (tx): Promise<MutateResult> => {
      const ref = col.users().doc(id);
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: false, reason: 'not_found' };
      const all = await tx.get(col.users()); // household-sized; also covers the admin guard atomically
      const user = toStored(snap);
      const admins = all.docs.filter((d) => isActiveAdmin(d.data() as UserDoc)).map((d) => d.id);
      const decision = fn(user, admins);
      if ('abort' in decision) return { ok: false, reason: decision.abort };
      if ('delete' in decision) {
        tx.delete(ref);
        tx.delete(col.usernames().doc(user.username));
        return { ok: true, user: null };
      }
      tx.update(ref, decision.patch as FirebaseFirestore.UpdateData<UserDoc>);
      return { ok: true, user: { ...user, ...decision.patch } };
    });
  }
}

/** In-memory store with the same semantics, for tests and local experiments. */
export class MemoryUserStore implements UserStore {
  users = new Map<string, UserDoc>();
  usernames = new Map<string, string>();
  private seq = 0;

  async isEmpty() { return this.users.size === 0; }
  async getById(id: string) {
    const u = this.users.get(id);
    return u ? { id, ...structuredClone(u) } : undefined;
  }
  async getByUsername(username: string) {
    const id = this.usernames.get(username);
    return id ? this.getById(id) : undefined;
  }
  async list() {
    return [...this.users.entries()].map(([id, u]) => ({ id, ...structuredClone(u) })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async create(doc: UserDoc) {
    if (this.usernames.has(doc.username)) throw new UsernameTakenError();
    const id = `u${++this.seq}`;
    this.users.set(id, structuredClone(doc));
    this.usernames.set(doc.username, id);
    return { id, ...structuredClone(doc) };
  }
  async mutate(id: string, fn: (u: StoredUser, activeAdminIds: string[]) => MutateDecision): Promise<MutateResult> {
    const cur = this.users.get(id);
    if (!cur) return { ok: false, reason: 'not_found' };
    const user: StoredUser = { id, ...structuredClone(cur) };
    const admins = [...this.users.entries()].filter(([, u]) => isActiveAdmin(u)).map(([i]) => i);
    const decision = fn(user, admins);
    if ('abort' in decision) return { ok: false, reason: decision.abort };
    if ('delete' in decision) {
      this.users.delete(id);
      this.usernames.delete(cur.username);
      return { ok: true, user: null };
    }
    const next = { ...cur, ...decision.patch };
    this.users.set(id, next);
    return { ok: true, user: { id, ...structuredClone(next) } };
  }
}
