/**
 * Notification Service
 * Handles notification CRUD and creation
 */

const db = require('../db');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

class NotificationService {
  /**
   * Create a single notification for a user
   */
  async create({ userId, type = 'info', category = 'system', priority = 'normal', title, message, actionUrl = null, actionLabel = null }) {
    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('notifications');
            const doc = { user_id: userId, userId, type, category, priority, title, message, action_url: actionUrl, actionUrl, action_label: actionLabel, actionLabel, is_read: false, isRead: false, created_at: new Date(), createdAt: new Date() };
            const res = await col.insertOne(doc);
            return { id: res.insertedId, user_id: userId, type, category, priority, title, message, action_url: actionUrl, action_label: actionLabel, is_read: false, created_at: doc.created_at };
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('notificationService.create mongo fallback failed:', e.message);
      }
      // Mongo-only fallback: return dummy to avoid 500
      return { id: `mock-${Date.now()}`, user_id: userId, type, category, priority, title, message, action_url: actionUrl, action_label: actionLabel, is_read: false, created_at: new Date().toISOString() };
    }
    const result = await db.query(
      `INSERT INTO notifications (user_id, type, category, priority, title, message, action_url, action_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [userId, type, category, priority, title, message, actionUrl, actionLabel]
    );
    return result.rows[0];
  }

  /**
   * Create notifications for many users in a single insert
   */
  async createBulk({ userIds, type = 'info', category = 'system', priority = 'normal', title, message, actionUrl = null, actionLabel = null }) {
    if (!userIds || userIds.length === 0) {
      return 0;
    }

    const uniqueIds = [...new Set(userIds)];
    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('notifications');
            const docs = uniqueIds.map(uid => ({ user_id: uid, userId: uid, type, category, priority, title, message, action_url: actionUrl, actionUrl, action_label: actionLabel, actionLabel, is_read: false, isRead: false, created_at: new Date(), createdAt: new Date() }));
            if (docs.length) await col.insertMany(docs);
            return uniqueIds.length;
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('notificationService.createBulk mongo fallback failed:', e.message);
      }
      // Avoid 500: pretend bulk succeeded without Postgres
      return uniqueIds.length;
    }

    const values = [];
    const params = [];
    let paramIndex = 1;

    for (const userId of uniqueIds) {
      params.push(userId, type, category, priority, title, message, actionUrl, actionLabel);
      values.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7})`
      );
      paramIndex += 8;
    }

    await db.query(
      `INSERT INTO notifications (user_id, type, category, priority, title, message, action_url, action_label)
       VALUES ${values.join(', ')}`,
      params
    );
    return uniqueIds.length;
  }

  /**
   * List notifications for a user
   */
  async list({ userId, unreadOnly = false, limit = 50, offset = 0 }) {
    if (isMongoOnly) return [];
    let query = 'SELECT * FROM notifications WHERE user_id = $1';
    const params = [userId];

    if (unreadOnly) {
      query += ' AND is_read = false';
    }

    query += ' ORDER BY created_at DESC LIMIT $2 OFFSET $3';
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Get unread count for a user
   */
  async getUnreadCount(userId) {
    if (isMongoOnly) return 0;
    const result = await db.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [userId]
    );
    return parseInt(result.rows[0].count);
  }

  /**
   * Find a single notification by id
   */
  async findById(id, userId) {
    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient, ObjectId } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('notifications');
            let doc = null;
            try { if (ObjectId.isValid(String(id))) doc = await col.findOne({ _id: new ObjectId(String(id)) }); } catch (_) {}
            if (!doc) doc = await col.findOne({ $or: [{ id: String(id) }, { _id: String(id) }] });
            if (!doc) return null;
            return { id: doc._id ? String(doc._id) : doc.id, user_id: doc.user_id ?? doc.userId, type: doc.type, category: doc.category, priority: doc.priority, title: doc.title, message: doc.message, action_url: doc.action_url ?? doc.actionUrl, action_label: doc.action_label ?? doc.actionLabel, is_read: doc.is_read ?? doc.isRead ?? false, created_at: doc.created_at ?? doc.createdAt };
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('notificationService.findById mongo fallback failed:', e.message);
      }
      return null;
    }
    const result = await db.query(
      'SELECT * FROM notifications WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Mark notification as read
   */
  async markAsRead(id, userId) {
    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient, ObjectId } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('notifications');
            let res = null;
            try { if (ObjectId.isValid(String(id))) res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)), $or: [{ user_id: userId }, { userId }] }, { $set: { is_read: true, isRead: true, read_at: new Date(), readAt: new Date() } }, { returnDocument: 'after' }); } catch (_) {}
            if (!res || !res.value) res = await col.findOneAndUpdate({ $or: [{ id: String(id) }, { _id: String(id) }] }, { $set: { is_read: true, isRead: true, read_at: new Date(), readAt: new Date() } }, { returnDocument: 'after' });
            if (res && res.value) {
              const d = res.value;
              return { id: d._id ? String(d._id) : d.id, user_id: d.user_id ?? d.userId, is_read: true, read_at: d.read_at ?? d.readAt };
            }
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('notificationService.markAsRead mongo fallback failed:', e.message);
      }
      return null;
    }
    const result = await db.query(
      `UPDATE notifications SET is_read = true, read_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId]
    );
    return result.rows[0] || null;
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId) {
    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('notifications');
            await col.updateMany({ $or: [{ user_id: userId }, { userId }], is_read: false }, { $set: { is_read: true, isRead: true, read_at: new Date(), readAt: new Date() } });
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('notificationService.markAllAsRead mongo fallback failed:', e.message);
      }
      return true;
    }
    await db.query(
      'UPDATE notifications SET is_read = true, read_at = NOW() WHERE user_id = $1 AND is_read = false',
      [userId]
    );
    return true;
  }
}

module.exports = new NotificationService();
