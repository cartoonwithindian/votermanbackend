const { Redis } = require('@upstash/redis');

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REQUEST_TIMEOUT_MS = 500;
const FAILURE_THRESHOLD = 2;
const COOLDOWN_MS = 30000;

let client = null;
let consecutiveFailures = 0;
let cooldownUntil = 0;

if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
  try {
    client = new Redis({
      url: UPSTASH_REDIS_REST_URL,
      token: UPSTASH_REDIS_REST_TOKEN,
      automaticDeserialization: false,
      signal: () => AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    console.warn('[redisCache] init failed, falling back to no-op:', e.message);
    client = null;
  }
}

function inCooldown() {
  return Date.now() < cooldownUntil;
}

function markSuccess() {
  consecutiveFailures = 0;
}

function markFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    console.warn(`[redisCache] ${consecutiveFailures} consecutive failures — pausing cache for ${COOLDOWN_MS / 1000}s`);
  }
}

function isEnabled() {
  return !!client && !inCooldown();
}

async function getKey(key) {
  if (!client || inCooldown()) return null;
  try {
    const raw = await client.get(key);
    if (raw == null) { markSuccess(); return null; }
    markSuccess();
    return JSON.parse(raw);
  } catch (e) {
    markFailure();
    console.warn('[redisCache] getKey failed:', e.message);
    return null;
  }
}

async function setKey(key, value, ttlSeconds) {
  if (!client || inCooldown()) return true;
  try {
    const raw = JSON.stringify(value);
    if (ttlSeconds != null && ttlSeconds > 0) {
      await client.set(key, raw, { ex: ttlSeconds });
    } else {
      await client.set(key, raw);
    }
    markSuccess();
    return true;
  } catch (e) {
    markFailure();
    console.warn('[redisCache] setKey failed:', e.message);
    return false;
  }
}

async function deleteKeysWithPrefix(prefix) {
  if (!client || inCooldown()) return 0;
  let deleted = 0;
  try {
    let cursor = 0;
    do {
      const [nextCursor, keys] = await client.scan(cursor, { match: `${prefix}*`, count: 100 });
      cursor = parseInt(nextCursor, 10) || 0;
      for (const key of keys) {
        try {
          await client.del(key);
          deleted++;
        } catch (_) {}
      }
    } while (cursor !== 0);
    markSuccess();
    return deleted;
  } catch (e) {
    markFailure();
    console.warn('[redisCache] deleteKeysWithPrefix failed:', e.message);
    return 0;
  }
}

module.exports = {
  getKey,
  setKey,
  deleteKeysWithPrefix,
  isEnabled,
};