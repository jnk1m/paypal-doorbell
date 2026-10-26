// Server-side coalescing (plan 9.7): requests for the same key share one computation. The screen's poll asks for a snapshot every few seconds
// from every open tab; two tabs of one session, or a retry, are answered from the one read instead of reading Redis and PayPal twice.
//   - while the computation is running, every request for the key waits for it (a scan can take longer than the window: a poll that arrives
//     during a 3 s scan does not start a second one);
//   - the window (2 s) starts when it has FINISHED, and a request inside it gets that answer;
//   - a computation that failed is not kept: the next request tries again.
// This is per server instance (a Map), which is all the plan asks for.
export function createCoalescer<T>(opts: { windowMs?: number; now?: () => number; max?: number } = {}) {
  const windowMs = opts.windowMs ?? 2000;
  const now = opts.now ?? Date.now;
  const max = opts.max ?? 500;
  const entries = new Map<string, { value: Promise<T>; settledAt?: number }>();
  return {
    run(key: string, produce: () => Promise<T>): Promise<T> {
      const kept = entries.get(key);
      if (kept && (kept.settledAt === undefined || now() - kept.settledAt < windowMs)) return kept.value; // still running, or finished inside the window
      const entry: { value: Promise<T>; settledAt?: number } = { value: produce() };
      entries.delete(key);
      entries.set(key, entry);
      entry.value.then(
        () => {
          entry.settledAt = now();
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key);
        },
      );
      if (entries.size > max) entries.delete(entries.keys().next().value as string); // the oldest goes first
      return entry.value;
    },
    size: () => entries.size,
  };
}
