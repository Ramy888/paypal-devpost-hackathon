// Fixed-window counter per key, in memory (one app instance). Protects paid API calls.
const windows = new Map<string, { start: number; count: number }>();

export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.set(key, { start: now, count: 1 });
    return true;
  }
  if (w.count >= limit) return false;
  w.count += 1;
  return true;
}
