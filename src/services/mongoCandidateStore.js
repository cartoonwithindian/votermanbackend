/**
 * MongoDB Atlas Candidate Store — Replaces data/candidates.json
 * When MONGODB_URI is set, students see Atlas candidates filtered by
 * their own department/year/section (cohort isolation: Card Profile).
 *
 * Collection: voteweb.candidates (or MONGODB_COLLECTION)
 * Docs shape: same as CandidateRow (lib/candidates-api.ts:9):
 *   {id, name, gender, department, year, section, description/bio, manifesto, image_url, position_id, position_name, election_id, election_name}
 */

const { MongoClient } = require('mongodb');
const { getMongoDbName } = require('../utils/mongoDbName');

let client = null;
let clientPromise = null;

function getMongoUri() {
  return process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.ATLAS_URI || process.env.ATLAS_URL || null;
}

function getDbName() {
  return getMongoDbName();
}

function getCollectionName() {
  return process.env.MONGODB_COLLECTION || 'candidates';
}

async function getClient() {
  const uri = getMongoUri();
  if (!uri) return null;
  if (client) return client;
  if (clientPromise) return clientPromise;
  clientPromise = new MongoClient(uri).connect().then(c => {
    client = c;
    return c;
  });
  return clientPromise;
}

async function getCollection() {
  const c = await getClient();
  if (!c) return null;
  const db = c.db(getDbName());
  return db.collection(getCollectionName());
}

let hasMongoCache = null;
let hasMongoCacheTime = 0;
const CACHE_TTL = 30000; // 30s

async function hasMongoCandidates() {
  if (!getMongoUri()) return false;
  // Cache 30s to avoid 2s stall per request when Atlas paused
  if (hasMongoCache !== null && Date.now() - hasMongoCacheTime < CACHE_TTL) {
    return hasMongoCache;
  }
  try {
    const col = await getCollection();
    if (!col) {
      hasMongoCache = false; hasMongoCacheTime = Date.now();
      return false;
    }
    const count = await col.countDocuments({}, { maxTimeMS: 500 });
    hasMongoCache = count > 0;
    hasMongoCacheTime = Date.now();
    return hasMongoCache;
  } catch (e) {
    hasMongoCache = false; hasMongoCacheTime = Date.now();
    return false;
  }
}

async function readMongoCandidates() {
  const col = await getCollection();
  if (!col) return null;
  return col.find({}).toArray();
}

async function writeMongoCandidates(candidates) {
  const col = await getCollection();
  if (!col) throw new Error('MONGODB_URI not configured');
  // Clear existing and insert new (admin upload replaces all)
  await col.deleteMany({});
  // Normalize to CandidateRow shape via jsonStore.mapJsonToRow
  const jsonStore = require('./jsonCandidateStore');
  const mapped = candidates.map((c, idx) => {
    const row = jsonStore.mapJsonToRow(c, idx);
    // Keep original id as _id for stable lookups, but also store id field
    return { _id: row.id, ...row, raw: c };
  });
  if (mapped.length) await col.insertMany(mapped, { ordered: false });
  // Recreate indexes for cohort filter
  await col.createIndex({ department: 1, year: 1, section: 1 });
  await col.createIndex({ gender: 1 });
  return { count: mapped.length };
}

async function deleteMongoCandidates() {
  const col = await getCollection();
  if (!col) return 0;
  const res = await col.deleteMany({});
  return res.deletedCount;
}

function filterMongoRows(rows, { gender, department, year, section, limit = 100, offset = 0 }) {
  let filtered = [...rows];
  if (gender && gender !== 'all') filtered = filtered.filter(r => r.gender === gender);
  if (department && department !== 'all') filtered = filtered.filter(r => r.department === department);
  if (year && year !== 'all') filtered = filtered.filter(r => r.year === year);
  if (section && section !== 'all') filtered = filtered.filter(r => r.section === section);
  const total = filtered.length;
  filtered = filtered.slice(offset, offset + limit);
  return { rows: filtered, total };
}

module.exports = {
  getMongoUri,
  getClient,
  getCollection,
  hasMongoCandidates,
  readMongoCandidates,
  writeMongoCandidates,
  deleteMongoCandidates,
  filterMongoRows,
};
