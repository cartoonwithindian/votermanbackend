const cache = new Map();

function memoryCacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function memoryCacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function memoryCacheDelPrefix(prefix) {
  let deleted = 0;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      deleted++;
    }
  }
  return deleted;
}

module.exports = { memoryCacheGet, memoryCacheSet, memoryCacheDelPrefix };