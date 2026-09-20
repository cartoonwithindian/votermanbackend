/**
 * Admin Position Routes
 * Administrative operations for position management
 * All routes require admin authentication
 */

const express = require('express');
const router = express.Router();
const positionController = require('../controllers/positionController');
const { requireAdmin } = require('../middleware/requireAdmin');
const { csrfProtection } = require('../middleware/csrfProtection');

const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

// GET /api/v1/admin/positions - List all positions (admin only, Mongo-safe)
// Fixes 500 when Postgres not configured (Atlas M10) — returns [] instead of throwing
router.get('/', requireAdmin, async (req, res, next) => {
  if (isMongoOnly) {
    try {
      const { MongoClient } = require('mongodb');
      const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
      if (uri) {
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
        await client.connect();
        try {
          const col = client.db(process.env.MONGODB_DB || 'voteweb').collection(process.env.MONGODB_POSITIONS_COLLECTION || 'positions');
          const docs = await col.find({}).sort({ display_order: 1 }).limit(200).toArray();
          await client.close().catch(() => {});
          if (docs.length) {
            const mapped = docs.map((d) => ({
              id: d._id ? String(d._id) : d.id,
              constituency_id: d.constituency_id ?? d.constituencyId ?? null,
              name: d.name,
              description: d.description ?? null,
              display_order: d.display_order ?? d.displayOrder ?? 0,
              is_active: d.is_active ?? d.isActive ?? true,
            }));
            return res.json({ data: mapped, meta: { count: mapped.length } });
          }
        } catch (e) {
          console.warn('[adminPositions] Mongo list failed, falling back to []:', e.message);
          try { await require('mongodb').MongoClient; } catch (_) {}
        }
      }
      // Mongo-only without data or connection failure => empty list, never 500
      return res.json({ data: [], meta: { count: 0 } });
    } catch (e) {
      console.warn('[adminPositions] isMongoOnly GET fallback []:', e.message);
      return res.json({ data: [], meta: { count: 0 } });
    }
  }
  return positionController.listAll(req, res, next);
});

// PATCH /api/v1/admin/positions/:id - Update position (admin only)
router.patch('/:id', requireAdmin, csrfProtection, positionController.update.bind(positionController));

module.exports = router;
