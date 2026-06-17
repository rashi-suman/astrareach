// Very small TTL cache. Replace with redis for multi-instance deploys.
const store = new Map();

function set(key, value, ttlMs = 60_000) {
  store.set(key, { value, expires: Date.now() + ttlMs });
}
function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { store.delete(key); return undefined; }
  return hit.value;
}
function del(key) { store.delete(key); }
function clear()  { store.clear(); }

module.exports = { get, set, del, clear };
