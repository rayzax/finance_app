/**
 * In-memory failure counter (sliding window of failure timestamps per key). Per instance: the per-account lockout
 * stored in Firestore is what holds across Cloud Run instances; this one bounds guessing per pending token / IP.
 */
export class FailureLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}

  private recent(key: string): number[] {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  blocked(...keys: string[]): boolean {
    return keys.some((k) => this.recent(k).length >= this.max);
  }

  fail(...keys: string[]): void {
    for (const k of keys) this.hits.set(k, [...this.recent(k), this.now()]);
    if (this.hits.size > 10_000) for (const k of this.hits.keys()) this.recent(k); // opportunistic cleanup
  }
}
