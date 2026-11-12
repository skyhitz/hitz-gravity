// A Workers KV namespace for tests: the part of the API the Worker uses, in
// memory. Expiry is recorded, not enforced: `ttl(key)` says what was asked.

export function fakeKv() {
  const entries = new Map();
  return {
    async get(key, options) {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      return options?.type === "json" ? JSON.parse(entry.value) : entry.value;
    },
    async put(key, value, options) {
      entries.set(key, { value: String(value), ttl: options?.expirationTtl ?? null });
    },
    async delete(key) {
      entries.delete(key);
    },
    /** Test-only: the expirationTtl a key was stored with (null for none, undefined if absent). */
    ttl: (key) => entries.get(key)?.ttl,
    keys: () => [...entries.keys()],
  };
}
