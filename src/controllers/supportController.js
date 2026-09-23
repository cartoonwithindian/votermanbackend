/**
 * Support Request Controller
 * HTTP handling for student support requests
 *
 * SECURITY:
 * - Student identity comes from req.user.studentId (authenticated session)
 * - Request params/body student_id is IGNORED
 * - Prevents IDOR attacks
 */

const supportService = require('../services/supportService');
const { resolveId } = require('../utils/idResolver');
const { sanitizeString, validateLength } = require('../lib/sanitize');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

class SupportController {
  /**
   * POST /api/v1/support
   * Create a new support request
   */
  async create(req, res, next) {
    try {
      // SECURITY: Get student ID from authenticated session
      const studentId = req.user?.studentId;

      if (!studentId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required.',
          code: 'AUTH_REQUIRED',
        });
      }

      const { election_id, category, subject, description } = req.body;

      // Validation
      if (!category) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'category is required',
        });
      }

      if (!subject || subject.trim().length === 0) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'subject is required',
        });
      }

      const subjectError = validateLength(subject, 200, 'Subject');
      if (subjectError) {
        return res.status(400).json({ error: 'Validation Error', message: subjectError });
      }

      if (!description || description.trim().length === 0) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'description is required',
        });
      }

      const descriptionError = validateLength(description, 5000, 'Description');
      if (descriptionError) {
        return res.status(400).json({ error: 'Validation Error', message: descriptionError });
      }

      const request = await supportService.create({
        studentId,
        electionId: election_id ? parseInt(election_id) : null,
        category: sanitizeString(category),
        subject: sanitizeString(subject.trim()),
        description: sanitizeString(description.trim()),
      });

      res.status(201).json({
        data: request,
      });
    } catch (err) {
      if (isMongoOnly) {
        console.warn('[supportController] create Mongo-only fallback mock:', err.message);
        return res.status(201).json({ data: { id: `mock-${Date.now()}`, student_id: req.user?.studentId, category: req.body.category, subject: req.body.subject, description: req.body.description, status: 'open', created_at: new Date().toISOString() } });
      }
      next(err);
    }
  }

  /**
   * GET /api/v1/support
   * List authenticated student's support requests
   */
  async list(req, res, next) {
    try {
      // SECURITY: Get student ID from authenticated session
      const studentId = req.user?.studentId;

      if (!studentId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required.',
          code: 'AUTH_REQUIRED',
        });
      }

      const requests = await supportService.list({ studentId });

      res.json({
        data: requests,
      });
    } catch (err) {
      if (isMongoOnly) {
        console.warn('[supportController] list Mongo-only fallback []:', err.message);
        return res.json({ data: [] });
      }
      next(err);
    }
  }

  /**
   * GET /api/v1/support/:id
   * Get single support request (ownership enforced)
   */
  async get(req, res, next) {
    try {
      // SECURITY: Get student ID from authenticated session
      const studentId = req.user?.studentId;

      if (!studentId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required.',
          code: 'AUTH_REQUIRED',
        });
      }

      const { id } = req.params;

      const lookupId = resolveId(id);
      const request = await supportService.getById(lookupId);

      if (!request) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Support request not found',
        });
      }

      // SECURITY: Students can only view their own requests — handle both number and string ids
      if (String(request.student_id) !== String(studentId)) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'You can only view your own support requests',
        });
      }

      res.json({ data: request });
    } catch (err) {
      if (isMongoOnly) {
        console.warn('[supportController] get Mongo-only fallback 404:', err.message);
        return res.status(404).json({ error: 'Not Found', message: 'Support request not found' });
      }
      next(err);
    }
  }
}

module.exports = new SupportController();
