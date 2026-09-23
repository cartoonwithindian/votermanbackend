/**
 * Election Controller
 * HTTP request handling for election management
 */

const electionService = require('../services/electionService');
const candidateAppService = require('../services/candidateApplicationService');
const masterCandidateMatcher = require('../services/masterCandidateMatcher');
const { normalizeDepartment, normalizeSection } = require('../utils/classList');
const { normalizeYear } = require('../utils/yearNormalizer');
const { auditLog } = require('../db');
const { ObjectId } = require('mongodb');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

const resolveElectionId = (raw) => {
  if (isMongoOnly && raw && ObjectId.isValid(String(raw))) return String(raw);
  return parseInt(raw, 10);
};

const VALID_STATUSES = ['DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED', 'PUBLISHED'];

class ElectionController {
  /**
   * GET /api/v1/elections
   */
  async list(req, res, next) {
    try {
      const { status, limit, offset } = req.query;

      // Validate status if provided
      if (status && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
        });
      }

      const MAX_LIMIT = 100;
      const parsedLimit = Math.min(parseInt(limit) || 100, MAX_LIMIT);

      // Non-admin viewers must NEVER see DRAFT elections (drafts are internal
      // working state; exposing them leaks upcoming/abandoned ballots). The
      // role is read from the server-side session, never the client.
      const viewerRole = (req.user?.role || '').toUpperCase();
      const isStaff = viewerRole === 'ADMIN' || viewerRole === 'CAD';
      const effectiveStatus = status
        ? status
        : null;

      const elections = await electionService.findAll({
        status: status || null,
        limit: parsedLimit,
        offset: parseInt(offset) || 0,
        excludeDraft: !isStaff,
      });

      // Class-scoped visibility: a student only sees elections whose scope
      // (department/year/semester/section) matches their OWN class, plus fully
      // unscoped elections. A single-class election (e.g. BCA 3 Sem A1) must
      // never be listed for a student of a different class.
      let visible = elections;
      if (!isStaff) {
        const u = req.user;
        const ud = String(u?.department ?? '').trim().toLowerCase();
        const uy = u?.year ?? u?.year_or_semester ?? '';
        const us = String(u?.section ?? '').trim().toLowerCase();
        visible = (elections || []).filter(e => {
          const eDept = String(e.department ?? '').trim();
          const eYear = String(e.year ?? e.semester ?? '').trim();
          const eSec = String(e.section ?? '').trim();
          if (!eDept && !eYear && !eSec) return true;
          if (!ud || !uy) return false;
          if (eDept && eDept.trim().toLowerCase() !== ud) return false;
          if (eYear) {
            const sameRaw = eYear.toLowerCase() === String(uy).trim().toLowerCase();
            const sameNorm = normalizeYear(eYear) && normalizeYear(eYear) === normalizeYear(uy);
            if (!sameRaw && !sameNorm) return false;
          }
          if (eSec && eSec.trim().toLowerCase() !== us) return false;
          return true;
        });
      }

      res.json({
        data: visible,
        meta: {
          count: visible.length,
          limit: parsedLimit,
          offset: parseInt(offset) || 0,
        },
      });
    } catch (err) {
      if (isMongoOnly) {
        console.warn('[electionController] list Mongo-only fallback []:', err.message);
        return res.json({ data: [], meta: { count: 0, limit: Math.min(parseInt(req.query.limit) || 100, 100), offset: parseInt(req.query.offset) || 0 } });
      }
      next(err);
    }
  }

  /**
   * GET /api/v1/elections/:id
   */
  async get(req, res, next) {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }
      if (!isMongoOnly && isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      const lookupId = resolveElectionId(id);
      const election = await electionService.findById(lookupId);

      if (!election) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${id} not found`,
        });
      }

      res.json({ data: election });
    } catch (err) {
      if (isMongoOnly) {
        console.warn('[electionController] get Mongo-only fallback 404:', err.message);
        return res.status(404).json({ error: 'Not Found', message: `Election with ID ${req.params.id} not found` });
      }
      next(err);
    }
  }

  /**
   * POST /api/v1/elections
   */
  async create(req, res, next) {
    try {
      const { name, description, start_time, end_time, classes, department, year, semester, section } = req.body;

      // Validate required fields
      if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'name is required and must be a non-empty string',
        });
      }

      // Validate name length
      if (name.length > 255) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'name must be 255 characters or less',
        });
      }

      // Validate timestamps if provided
      if (start_time) {
        const startDate = new Date(start_time);
        if (isNaN(startDate.getTime())) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'start_time must be a valid timestamp',
          });
        }
      }

      if (end_time) {
        const endDate = new Date(end_time);
        if (isNaN(endDate.getTime())) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'end_time must be a valid timestamp',
          });
        }
      }

      // Validate end_time > start_time if both provided
      if (start_time && end_time) {
        const startDate = new Date(start_time);
        const endDate = new Date(end_time);
        if (endDate <= startDate) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'end_time must be after start_time',
          });
        }
      }

      const election = await electionService.create({
        name: name.trim(),
        description: description?.trim() || null,
        start_time: start_time ? new Date(start_time).toISOString() : null,
        end_time: end_time ? new Date(end_time).toISOString() : null,
        department: department ? normalizeDepartment(department) : null,
        year: year ? normalizeYear(year) || String(year).trim() : null,
        semester: semester ? String(semester).trim() : null,
        section: section ? normalizeSection(section) : null,
      });

      // Class setup (optional): select classes from the 22-class list at
      // creation time. Each class gets its two CR seats via
      // constituencyService.create; master candidates are auto-matched onto
      // them. Idempotent — an election id that already has the class reuses it.
      const classSetup = {
        requested: Array.isArray(classes) ? classes.length : 0,
        created: [],
        placed: 0,
        skipped: 0,
      };
      if (Array.isArray(classes) && classes.length > 0) {
        const electionId = String(election.id ?? election._id ?? election.postgresId ?? election.id);
        const seen = new Set();
        for (const cls of classes) {
          const department = normalizeDepartment(cls.department);
          const year = normalizeYear(cls.year) || String(cls.year || '').trim();
          const section = normalizeSection(cls.section);
          if (!department || !year) continue;
          const key = `${department}|${year}|${section}`;
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            const outcome = await masterCandidateMatcher.matchClassForElection(
              electionId,
              { department, year, section }
            );
            if (outcome.constituency) {
              classSetup.created.push({ department, year, section, constituencyId: outcome.constituency.id });
            }
            classSetup.placed += (outcome.placed || []).length;
            classSetup.skipped += (outcome.skipped || []).length;
          } catch (err) {
            console.warn('[electionController] class setup failed', { department, year, section, code: err.code || err.message });
            classSetup.skipped += 1;
          }
        }
      }

      // Audit log: election created
      await auditLog('ELECTION_CREATED', {
        electionId: election.id,
        name: election.name,
        status: election.status,
        adminUserId: req.adminUser?.id,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.status(201).json({ data: election, class_setup: classSetup });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/elections/:id
   */
  async update(req, res, next) {
    try {
      const { id } = req.params;
      const { name, description, start_time, end_time } = req.body;

      if (!id || (!isMongoOnly && isNaN(parseInt(id)))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      // Validate name length if provided
      if (name !== undefined) {
        if (typeof name !== 'string' || name.trim() === '') {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'name must be a non-empty string if provided',
          });
        }
        if (name.length > 255) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'name must be 255 characters or less',
          });
        }
      }

      // Validate timestamps if provided
      if (start_time) {
        const startDate = new Date(start_time);
        if (isNaN(startDate.getTime())) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'start_time must be a valid timestamp',
          });
        }
      }

      if (end_time) {
        const endDate = new Date(end_time);
        if (isNaN(endDate.getTime())) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'end_time must be a valid timestamp',
          });
        }
      }

      // Validate end_time > start_time if both provided
      if (start_time && end_time) {
        const startDate = new Date(start_time);
        const endDate = new Date(end_time);
        if (endDate <= startDate) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'end_time must be after start_time',
          });
        }
      }

      const result = await electionService.update(resolveElectionId(id), {
        name: name?.trim(),
        description: description !== undefined ? (description?.trim() || null) : undefined,
        start_time: start_time ? new Date(start_time).toISOString() : undefined,
        end_time: end_time ? new Date(end_time).toISOString() : undefined,
      });

      if (result === null) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${id} not found`,
        });
      }

      if (result.error) {
        return res.status(result.status || 400).json({
          error: result.error,
          message: result.message,
        });
      }

      res.json({ data: result });
    } catch (err) {
      // Handle protected field error
      if (err.code === 'PROTECTED_FIELD' || err.code === 'ELECTION_CLOSED') {
        return res.status(403).json({
          error: 'Forbidden',
          message: err.message,
          protectedFields: err.fields,
        });
      }
      next(err);
    }
  }

  /**
   * PATCH /api/v1/elections/:id/status
   */
  async updateStatus(req, res, next) {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!id || (!isMongoOnly && isNaN(parseInt(id)))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      // Validate status value
      if (!status || !VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          error: 'Validation Error',
          message: `status must be one of: ${VALID_STATUSES.join(', ')}`,
        });
      }

      const result = await electionService.updateStatus(resolveElectionId(id), status);

      if (result.error === 'NOT_FOUND') {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${id} not found`,
        });
      }

      if (result.error === 'INVALID_TRANSITION') {
        return res.status(409).json({
          error: 'Conflict',
          message: result.message,
          currentStatus: result.currentStatus,
          allowedTransitions: result.allowedTransitions,
        });
      }

      if (result.error === 'PROTECTED') {
        return res.status(403).json({
          error: 'Forbidden',
          message: result.message,
        });
      }

      // Audit log: election status changed
      await auditLog('ELECTION_STATUS_CHANGED', {
        electionId: resolveElectionId(id),
        previousStatus: result.previousStatus,
        newStatus: status,
        adminUserId: req.adminUser?.id,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });

      // Opening the election makes every approved CR candidate ballot-ready:
      // auto-place any approved-but-unplaced applications onto this
      // election's constituencies. Best-effort — never fails the status change.
      let autoPlaced = [];
      if (status === 'OPEN') {
        try {
          const outcome = await candidateAppService.placeUnplacedForElection(resolveElectionId(id));
          autoPlaced = outcome.placed;
        } catch (err) {
          console.warn('updateStatus: auto ballot placement failed', { electionId: id, code: err.code || err.message });
        }
      }

      res.json({ data: result.election, meta: { autoPlaced } });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/elections/:id/readiness
   * Check if election is ready to be opened
   */
  async getReadiness(req, res, next) {
    try {
      const { id } = req.params;

      if (!id || (!isMongoOnly && isNaN(parseInt(id)))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      const result = await electionService.getReadiness(resolveElectionId(id));

      if (result.error === 'NOT_FOUND') {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${id} not found`,
        });
      }

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/elections/:id/results
   * Get aggregated election results
   * Only returns results if election status is RESULTS_PUBLISHED or if admin requests
   */
  async getResults(req, res, next) {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }
      if (!isMongoOnly && isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      const lookupId = resolveElectionId(id);
      const result = await electionService.getResults(lookupId);

      if (result.error === 'NOT_FOUND') {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${id} not found`,
        });
      }

      if (result.error === 'NOT_PUBLISHED') {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Results have not been published for this election',
        });
      }

      // Return aggregated results without individual vote data
      res.json({
        data: {
          electionId: result.electionId,
          electionName: result.electionName,
          publishedAt: result.publishedAt,
          status: result.status,
          totalEligible: result.totalEligible,
          totalVotes: result.totalVotes,
          participation: result.participation,
          constituencies: result.constituencies,
        },
      });
    } catch (err) {
      if (isMongoOnly) {
        console.warn('[electionController] getResults Mongo-only fallback empty:', err.message);
        return res.json({ data: { electionId: req.params.id, electionName: 'Election', publishedAt: null, status: 'published', totalEligible: 0, totalVotes: 0, participation: 0, constituencies: [] } });
      }
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/elections/:id/publish
   * Publish election results - sets results_published_at timestamp
   */
  async publishResults(req, res, next) {
    try {
      const { id } = req.params;

      if (!id || (!isMongoOnly && isNaN(parseInt(id)))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      const adminUserId = req.adminUser?.id || 1;
      const result = await electionService.publishResults(resolveElectionId(id), adminUserId);

      if (result.error === 'NOT_FOUND') {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${id} not found`,
        });
      }

      if (result.error === 'INVALID_STATE') {
        return res.status(409).json({
          error: 'Conflict',
          message: result.message,
        });
      }

      // Audit log
      await auditLog('RESULTS_PUBLISHED', {
        electionId: resolveElectionId(id),
        adminUserId,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.json({ data: result.election });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new ElectionController();
