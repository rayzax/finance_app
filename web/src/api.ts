export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

interface Opts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** do not treat a 401 as "session expired" (used by login and the auth probe) */
  noRedirect?: boolean;
}

export async function api<T>(path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'reserve' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !opts.noRedirect) {
    onUnauthorized?.();
    throw new ApiError(401, 'Signed out');
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
