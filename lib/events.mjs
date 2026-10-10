// In-memory store of verified webhook events with live subscribers.
// One instance per process; fine while the app runs as a single Render instance.

const KEEP_EVENTS = 50;

export function createEventStore() {
  const events = [];
  const seen = new Set();
  const subscribers = new Set();

  return {
    // Returns false for an event id already recorded (PayPal retries deliveries).
    add(summary) {
      if (seen.has(summary.id)) return false;
      seen.add(summary.id);
      events.unshift(summary);
      if (events.length > KEEP_EVENTS) seen.delete(events.pop().id);
      for (const fn of subscribers) fn(summary);
      return true;
    },
    recent: () => [...events],
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

// Route handlers can be bundled separately, so share one store through globalThis.
export const eventStore = (globalThis.__collectpilotEvents ??= createEventStore());

/** Tells open pages a retainer changed, so /retainers refreshes. Not an invoice event: no invoice_id. */
export function notifyRetainerChange(store = eventStore, now = new Date()) {
  store.add({ id: `RETAINER-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`, event_type: "APP.RETAINER.UPDATED", invoice_id: null, received_at: now.toISOString() });
}
