/**
 * Candidate Controller
 * HTTP request handling for candidate management.
 *
 * PUBLIC ENDPOINTS:
 * - GET /candidates         : List approved candidates for student view
 * - GET /candidates/:id     : Get single candidate (public)
 *
 * These endpoints return candidates from candidate_applications with status='approved'.
 */

const candidateService = require('../services/candidateService');
const jsonStore = require('../services/jsonCandidateStore');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

class CandidateController {
  /**
   * GET /api/v1/candidates - List approved candidates for public/student view
   *
   * Returns candidates from candidate_applications with status='approved'.
   * Supports filtering by gender, department, year, and section.
   */
  async listAll(req, res, next) {
    try {
      const {
        active_only,
        limit,
        offset,
        gender,      // 'Male', 'Female', 'Other'
      } = req.query;

      // Students always see only their own cohort's candidates. When an
      // authenticated student with a complete class on file (department,
      // year, section) hits this endpoint, ignore any client-supplied
      // department/year/section and scope to that exact class — a student can
      // never browse other courses, other years, or other sections here.
      // Unauthenticated consumers (and authed rows missing class data) keep
      // the previous optional filters.
      const u = req.user;
      const hasOwnClass = Boolean(u && u.department && u.year && u.section);
      const department = hasOwnClass ? u.department : req.query.department;
      const year = hasOwnClass ? u.year : req.query.year;
      const section = hasOwnClass ? u.section : req.query.section;

      const candidates = await candidateService.findApproved({
        activeOnly: active_only !== 'false',
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
        gender,
        department,
        year,
        section,
      });

      res.json({
        data: candidates,
        meta: {
          count: candidates.length,
        },
      });
    } catch (err) {
      if (isMongoOnly) {
        console.warn('[candidateController] listAll Mongo-only fallback []:', err.message);
        return res.json({ data: [], meta: { count: 0 } });
      }
      next(err);
    }
  }

  /**
   * GET /api/v1/candidates/:id - Get single candidate (public)
   */
  async get(req, res, next) {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid candidate ID',
        });
      }
      if (!isMongoOnly && isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid candidate ID',
        });
      }

      const lookupId = isMongoOnly && isNaN(parseInt(id)) ? id : parseInt(id);
      const candidate = await candidateService.findApprovedById(lookupId);

      if (!candidate) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Candidate not found',
        });
      }

      res.json({
        data: candidate,
      });
    } catch (err) {
      if (isMongoOnly) {
        console.warn('[candidateController] get Mongo-only fallback 404:', err.message);
        return res.status(404).json({ error: 'Not Found', message: 'Candidate not found' });
      }
      next(err);
    }
  }

  /**
   * GET /api/v1/positions/:positionId/candidates
   */
  async list(req, res, next) {
    try {
      const { positionId } = req.params;
      const { active_only, limit, offset } = req.query;

      if (!positionId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid position ID',
        });
      }
      if (!isMongoOnly && isNaN(parseInt(positionId))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid position ID',
        });
      }

      const pid = isMongoOnly && isNaN(parseInt(positionId)) ? positionId : parseInt(positionId);
      const candidates = await candidateService.findByPositionId(pid, {
        activeOnly: active_only !== 'false',
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
      });

      res.json({
        data: candidates,
        meta: {
          count: candidates.length,
        },
      });
    } catch (err) {
      if (isMongoOnly) {
        console.warn('[candidateController] list Mongo-only fallback []:', err.message);
        return res.json({ data: [], meta: { count: 0 } });
      }
      next(err);
    }
  }

  /**
   * PATCH /api/v1/candidates/:id - Update candidate (admin only)
   *
   * Admin-only endpoint for managing ballot candidates.
   * Public reads stay open; writes require an authenticated ADMIN session, a
   * valid CSRF token, and the election must be DRAFT/SCHEDULED.
   */
  async update(req, res, next) {
    try {
      const { id } = req.params;
      const { name, description, image_url, display_order } = req.body;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid candidate ID',
        });
      }

      // Check election state - only allow modification in DRAFT/SCHEDULED
      const canModify = await candidateService.canModify(parseInt(id));
      if (!canModify) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Cannot modify candidate when election is OPEN or CLOSED',
        });
      }

      const candidate = await candidateService.update(parseInt(id), {
        name,
        description,
        image_url,
        display_order,
      });

      res.json({ data: candidate });
    } catch (err) {
      // Handle duplicate name constraint
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'Conflict',
          message: `A candidate with name '${req.body.name}' already exists in this position`,
        });
      }
      next(err);
    }
  }

  // =====================================================
  // JSON CANDIDATE ADMIN ENDPOINTS
  // =====================================================

  /**
   * POST /api/v1/admin/candidates/json — upload JSON array
   * Body: { candidates: [...] }  (Card: profilePhotoUrl,name,position,dept/year,bio + Profile: manifesto etc.)
   * Cohort filter (department/year/section) stays server-enforced for students.
   */
  async uploadJson(req, res, next) {
    try {
      const payload = req.body.candidates || req.body.data || req.body;
      const arr = Array.isArray(payload) ? payload : Array.isArray(payload.candidates) ? payload.candidates : null;
      if (!arr) return res.status(400).json({ error: 'Bad Request', message: 'Body must be {candidates:[...]} or [...]', code: 'INVALID_JSON' });
      const err = jsonStore.validateCandidates(arr);
      if (err) return res.status(400).json({ error: 'Bad Request', message: err, code: 'VALIDATION_ERROR' });
      const mapped = arr.map((c, i) => jsonStore.mapJsonToRow(c, i));
      const saved = jsonStore.writeJsonCandidates(arr);
      return res.json({ success: true, message: `Uploaded ${arr.length} candidates from JSON`, count: arr.length, path: saved.path, preview: mapped.slice(0, 2) });
    } catch (e) { next(e); }
  }

  async getJson(req, res, next) {
    try {
      const raw = jsonStore.readJsonCandidates();
      if (!raw) return res.json({ hasJson: false, count: 0, candidates: [] });
      return res.json({ hasJson: true, count: raw.length, candidates: raw });
    } catch (e) { next(e); }
  }

  async deleteJson(req, res, next) {
    try {
      const deleted = jsonStore.deleteJsonCandidates();
      return res.json({ success: true, deleted, message: deleted ? 'JSON override removed, DB is now active' : 'No JSON to delete' });
    } catch (e) { next(e); }
  }
}

module.exports = new CandidateController();
