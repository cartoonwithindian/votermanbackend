const { MongoClient } = require('mongodb');

let client = null;
let clientPromise = null;

function getMongoUri() {
  return process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.ATLAS_URI || process.env.ATLAS_URL || null;
}

function getDbName() {
  return process.env.MONGODB_DB || 'voteweb';
}

async function getClient() {
  const uri = getMongoUri();
  if (!uri) return null;
  if (client) return client;
  if (clientPromise) return clientPromise;
  clientPromise = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    maxPoolSize: 50,
    minPoolSize: 1,
    maxIdleTimeMS: 120000,
  }).connect()
    .then((c) => {
      client = c;
      return c;
    })
    .catch((e) => {
      clientPromise = null;
      throw e;
    });
  return clientPromise;
}

function getDb() {
  return getClient().then((c) => (c ? c.db(getDbName()) : null));
}

async function isEnabled() {
  const c = await getClient();
  return !!c;
}

module.exports = {
  getMongoUri,
  getDbName,
  getClient,
  getDb,
  isEnabled,
};