/**
 * MongoDB Database Name Resolver
 *
 * Each school/deployment gets its own MongoDB database in the same Atlas cluster.
 * Set MONGODB_DB=voteweb_{school_code} per deployment (e.g., voteweb_s1, voteweb_s2).
 *
 * This ensures complete data isolation between schools:
 * - Students, elections, votes, candidates are all school-scoped
 * - No cross-school data leakage possible
 * - Same Atlas cluster, separate databases = zero overlap
 */

/**
 * Get the MongoDB database name for this deployment.
 *
 * Priority:
 * 1. MONGODB_DB env var (e.g., "voteweb_s1") — explicit per-school override
 * 2. "voteweb" default — backward compatible single-school deployments
 *
 * @returns {string} Database name
 */
function getMongoDbName() {
  return process.env.MONGODB_DB || 'voteweb';
}

/**
 * Get a collection from the school-scoped database.
 *
 * @param {MongoClient} client - Connected MongoClient
 * @param {string} collectionName - Collection name (e.g., 'students', 'votes')
 * @returns {Collection} MongoDB collection
 */
function getSchoolCollection(client, collectionName) {
  return client.db(getMongoDbName()).collection(collectionName);
}

module.exports = { getMongoDbName, getSchoolCollection };
