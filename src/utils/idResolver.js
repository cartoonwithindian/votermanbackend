/**
 * idResolver — single source of truth for turning a raw route/query id into
 * the key shape the current storage backend expects.
 *
 * Postgres ids are integers ("123").
 * Mongo-only ids are strings (ObjectId hex, e.g. "6ab3760b4b000c279858bb27").
 *
 * Rule: a purely numeric string is an integer id; anything else is kept as a
 * string. This MUST be used instead of localStorage-style `parseInt(id)` —
 * parseInt("6ab3760b4b000c279858bb27") silently truncates to 6 and breaks
 * every lookup.
 */

function resolveId(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return /^\d+$/.test(s) ? parseInt(s, 10) : s;
}

module.exports = { resolveId };