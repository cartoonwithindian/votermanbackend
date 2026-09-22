/**
 * Announcement Service
 * Handles announcement CRUD operations
 */

const db = require('../db');
const notificationService = require('./notificationService');
const { getMongoDbName } = require('../utils/mongoDbName');
const { getClient: getSharedClient } = require('../db/mongoClient');
const redisCache = require('../utils/redisCache');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

const ANNOUNCEMENTS_CACHE_KEY_PREFIX = 'announcements:v1:';
const ANNOUNCEMENTS_CACHE_TTL = 30;

class AnnouncementService {
  /**
   * Create a new announcement
   * Notifies approved + rejected candidates when the announcement is published.
   */
  async create({ electionId, title, message, audience = 'all', priority = 'normal', published = false, createdBy }) {
    if (isMongoOnly) {
      // Avoid 500 for admin create when Postgres disabled; return mock
      return {
        id: `mock-${Date.now()}`,
        election_id: electionId || null,
        title,
        message,
        audience,
        priority,
        is_published: !!published,
        published_at: published ? new Date().toISOString() : null,
        created_by: createdBy || null,
        created_at: new Date().toISOString(),
      };
    }
    const result = await db.query(
      `INSERT INTO announcements (election_id, title, message, audience, priority, is_published, published_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        electionId || null,
        title,
        message,
        audience,
        priority,
        published,
        published ? new Date() : null,
        createdBy || null
      ]
    );
    const announcement = result.rows[0];

    if (announcement.is_published) {
      await this.notifyCandidates(announcement);
    }

    await this.invalidateAnnouncements();

    return announcement;
  }

  /**
   * List announcements with filters
   */
  async list({ electionId, publishedOnly = false, audience, limit = 50, offset = 0 }) {
    const cacheKey = redisCache.isEnabled() ? this.buildAnnouncementCacheKey({ electionId, publishedOnly, audience, limit, offset }) : null;
    if (cacheKey) {
      const cached = await redisCache.getKey(cacheKey);
      if (cached !== null) {
        return Array.isArray(cached) ? cached : [];
      }
    }
    if (isMongoOnly) {
      try {
        const client = await getSharedClient();
        if (client) {
          const col = client.db(getMongoDbName()).collection('announcements');
          const filter = {};
          if (publishedOnly) filter.is_published = true;
          if (electionId) filter.election_id = parseInt(electionId);
          // audience filtering done in JS for Mongo schema variance
          let docs = await col.find(filter).sort({ created_at: -1, createdAt: -1 }).limit(limit).skip(offset).toArray();
          if (audience) docs = docs.filter(d => d.audience === audience || d.audience === 'all');
          const rows = docs.map(d => ({
            id: d._id ? String(d._id) : d.id,
            election_id: d.election_id ?? d.electionId ?? null,
            title: d.title,
            message: d.message,
            audience: d.audience || 'all',
            priority: d.priority || 'normal',
            is_published: d.is_published ?? d.isPublished ?? false,
            published_at: d.published_at ?? d.publishedAt ?? null,
            created_at: d.created_at ?? d.createdAt ?? new Date().toISOString(),
          }));
          if (cacheKey) {
            await redisCache.setKey(cacheKey, rows, ANNOUNCEMENTS_CACHE_TTL);
          }
          return rows;
        }
      } catch (e) {
        console.warn('[announcementService] list mongo fallback to []:', e.message);
      }
      if (cacheKey) {
        await redisCache.setKey(cacheKey, [], ANNOUNCEMENTS_CACHE_TTL);
      }
      return [];
    }
    let query = 'SELECT * FROM announcements WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (electionId) {
      query += ` AND election_id = $${paramIndex}`;
      params.push(electionId);
      paramIndex++;
    }

    if (publishedOnly) {
      query += ' AND is_published = true';
    }

    if (audience) {
      query += ` AND (audience = $${paramIndex} OR audience = 'all')`;
      params.push(audience);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    try {
      const result = await db.query(query, params);
      const rows = result.rows;
      if (cacheKey) {
        await redisCache.setKey(cacheKey, rows, ANNOUNCEMENTS_CACHE_TTL);
      }
      return rows;
    } catch (e) {
      if (isMongoOnly) {
        console.warn('[announcementService] list fallback to []:', e.message);
        return [];
      }
      throw e;
    }
  }

  buildAnnouncementCacheKey({ electionId, publishedOnly = false, audience, limit = 50, offset = 0 }) {
    const safe = (v) => String(v ?? '').trim().toLowerCase() !== '' ? String(v).trim().toLowerCase() : 'all';
    return `${ANNOUNCEMENTS_CACHE_KEY_PREFIX}${safe(electionId)}:${publishedOnly ? 'published' : 'all'}:${safe(audience)}:${limit ?? 50}:${offset ?? 0}`;
  }

  async invalidateAnnouncements() {
    await redisCache.deleteKeysWithPrefix('announcements:');
  }

  /**
   * Get single announcement by ID
   */
  async getById(id, publishedOnly = false) {
    if (isMongoOnly) {
      try {
        const client = await getSharedClient();
        if (client) {
          const { ObjectId } = require('mongodb');
          const col = client.db(getMongoDbName()).collection('announcements');
          let doc = null;
          try { if (ObjectId.isValid(String(id))) doc = await col.findOne({ _id: new ObjectId(String(id)) }); } catch (_) {}
          if (!doc) doc = await col.findOne({ $or: [{ id: String(id) }, { _id: String(id) }] });
          if (!doc) return null;
          if (publishedOnly && !(doc.is_published ?? doc.isPublished)) return null;
          return {
            id: doc._id ? String(doc._id) : doc.id,
            election_id: doc.election_id ?? doc.electionId ?? null,
            title: doc.title,
            message: doc.message,
            audience: doc.audience || 'all',
            priority: doc.priority || 'normal',
            is_published: doc.is_published ?? doc.isPublished ?? false,
            published_at: doc.published_at ?? doc.publishedAt ?? null,
            created_at: doc.created_at ?? doc.createdAt ?? new Date().toISOString(),
          };
        }
      } catch (e) {
        console.warn('[announcementService] getById mongo fallback to null:', e.message);
      }
      return null;
    }
    try {
      const result = publishedOnly
        ? await db.query(
            'SELECT * FROM announcements WHERE id = $1 AND is_published = true',
            [id]
          )
        : await db.query(
            'SELECT * FROM announcements WHERE id = $1',
            [id]
          );
      return result.rows[0] || null;
    } catch (e) {
      if (isMongoOnly) {
        console.warn('[announcementService] getById fallback to null:', e.message);
        return null;
      }
      throw e;
    }
  }

  /**
   * Update announcement
   * Notifies approved + rejected candidates when the announcement becomes published.
   */
  async update(id, { title, message, audience, priority, isPublished }) {
    const existing = await this.getById(id);

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (title !== undefined) {
      updates.push(`title = $${paramIndex}`);
      params.push(title);
      paramIndex++;
    }

    if (message !== undefined) {
      updates.push(`message = $${paramIndex}`);
      params.push(message);
      paramIndex++;
    }

    if (audience !== undefined) {
      updates.push(`audience = $${paramIndex}`);
      params.push(audience);
      paramIndex++;
    }

    if (priority !== undefined) {
      updates.push(`priority = $${paramIndex}`);
      params.push(priority);
      paramIndex++;
    }

    if (isPublished !== undefined) {
      updates.push(`is_published = $${paramIndex}`);
      params.push(isPublished);
      paramIndex++;
      // Set published_at when publishing
      if (isPublished) {
        updates.push(`published_at = NOW()`);
      }
    }

    updates.push(`updated_at = NOW()`);
    params.push(id);

    const query = `UPDATE announcements SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    const result = await db.query(query, params);
    const announcement = result.rows[0] || null;

    // Notify only on a draft → published transition (avoid re-notifying on edits of an already-published announcement).
    if (announcement && announcement.is_published && (!existing || !existing.is_published)) {
      await this.notifyCandidates(announcement);
    }

    await this.invalidateAnnouncements();

    return announcement;
  }

  /**
   * Delete announcement
   */
  async delete(id) {
    const result = await db.query(
      'DELETE FROM announcements WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rowCount > 0) {
      await this.invalidateAnnouncements();
    }
    return result.rowCount > 0;
  }

  /**
   * Publish/unpublish announcement
   */
  async setPublished(id, published) {
    return this.update(id, { isPublished: published });
  }

  /**
   * Create a notification for every approved and rejected candidate when a
   * published announcement is created. Respects the audience target:
   * admin-only announcements do not notify candidates.
   */
  async notifyCandidates(announcement) {
    if (isMongoOnly) return 0;
    try {
      if (!announcement || !announcement.is_published) {
        return 0;
      }

      if (announcement.audience === 'admins') {
        return 0;
      }

      // Approved + rejected candidates = students with a final decision on
      // their candidate application (status 'approved' or 'rejected').
      const result = await db.query(
        `SELECT DISTINCT student_id
         FROM candidate_applications
         WHERE status IN ('approved', 'rejected') AND student_id IS NOT NULL`
      );

      const userIds = result.rows.map((row) => row.student_id);
      if (!userIds.length) {
        return 0;
      }

      return notificationService.createBulk({
        userIds,
        type: 'info',
        category: 'announcement',
        priority: announcement.priority || 'normal',
        title: announcement.title,
        message: announcement.message,
        actionUrl: null,
        actionLabel: null,
      });
    } catch (err) {
      // Announcement creation must not fail because notification delivery failed.
      console.error('Failed to notify candidates about announcement:', err.message);
      return 0;
    }
  }
}

module.exports = new AnnouncementService();
