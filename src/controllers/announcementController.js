/**
 * Announcement Controller
 * HTTP handling for announcement management
 */

const announcementService = require('../services/announcementService');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

class AnnouncementController {
  /**
   * GET /api/v1/announcements
   * List published announcements (public)
   */
  async list(req, res, next) {
    try {
      const { election_id, audience, limit, offset } = req.query;

      const announcements = await announcementService.list({
        electionId: election_id ? parseInt(election_id) : null,
        publishedOnly: true,
        audience: audience || null,
        limit: Math.min(parseInt(limit) || 50, 100),
        offset: parseInt(offset) || 0,
      });

      res.json({ data: announcements });
    } catch (err) {
      if (isMongoOnly) {
        console.warn('[announcementController] list Mongo-only fallback []:', err.message);
        return res.json({ data: [] });
      }
      next(err);
    }
  }

  /**
   * GET /api/v1/announcements/:id
   * Get single announcement (public if published)
   */
  async get(req, res, next) {
    try {
      const { id } = req.params;
      const lookupId = isMongoOnly && isNaN(parseInt(id)) ? id : parseInt(id);
      const announcement = await announcementService.getById(lookupId, true);

      if (!announcement) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Announcement not found',
        });
      }

      res.json({ data: announcement });
    } catch (err) {
      if (isMongoOnly) {
        console.warn('[announcementController] get Mongo-only fallback 404:', err.message);
        return res.status(404).json({ error: 'Not Found', message: 'Announcement not found' });
      }
      next(err);
    }
  }
}

module.exports = new AnnouncementController();
