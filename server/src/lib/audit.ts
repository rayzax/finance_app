/**
 * Structured auth/audit log lines (one JSON object per line, Cloud Logging picks up `severity`).
 * Never pass passwords, codes, secrets or tokens in `fields`; only ids, usernames and the client IP.
 */
export type AuditEvent =
  | 'login_success' | 'login_failure' | 'login_locked' | 'bootstrap_admin_created'
  | 'mfa_success' | 'mfa_failure' | 'mfa_recovery_code_used' | 'mfa_rate_limited'
  | 'mfa_enrolled' | 'recovery_codes_regenerated'
  | 'password_changed' | 'password_change_failure'
  | 'user_created' | 'user_updated' | 'user_deleted' | 'user_password_reset' | 'user_mfa_reset'
  | 'logout';

export interface AuditFields {
  userId?: string | null;
  username?: string | null;
  ip?: string | null;
  actorId?: string | null;
  actorUsername?: string | null;
  reason?: string;
  changes?: string[];
}

let sink: (line: string) => void = (l) => console.log(l);
/** Tests capture the log here. */
export function setAuditSink(fn: ((line: string) => void) | null) {
  sink = fn ?? ((l) => console.log(l));
}

const WARN = new Set<AuditEvent>(['login_failure', 'login_locked', 'mfa_failure', 'mfa_rate_limited', 'password_change_failure']);

export function audit(event: AuditEvent, fields: AuditFields = {}): void {
  sink(JSON.stringify({ severity: WARN.has(event) ? 'WARNING' : 'INFO', message: `auth:${event}`, event, ...fields }));
}
