// One queue per process for work that moves money or creates PayPal invoices: agent passes,
// and the chunk invoice a client's approval creates. Jobs run one at a time, in order.
const g = globalThis as typeof globalThis & { __collectpilotQueue?: Promise<unknown> };

export function serialized<T>(job: () => Promise<T>): Promise<T> {
  const run = (g.__collectpilotQueue ?? Promise.resolve()).catch(() => {}).then(job);
  g.__collectpilotQueue = run;
  return run;
}
