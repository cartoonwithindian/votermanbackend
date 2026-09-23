/**
 * Constituency Controller
 * HTTP request handling for Class Representative (CR) constituencies.
 *
 * Security model:
 *  - Reads are public (ballot data).
 *  - Writes require an authenticated ADMIN session + CSRF, and the owning
 *    election must be DRAFT/SCHEDULED.
 */

const constituencyService = require('../services/constituencyService');
const candidateAppService = require('../services/candidateApplicationService');
const masterCandidateMatcher = require('../services/masterCandidateMatcher');
const electionService = require('../services/electionService');
const positionService = require('../services/positionService');
const { ObjectId } = require('mongodb');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

const resolveId = (raw) => {
  if (isMongoOnly && raw && ObjectId.isValid(String(raw))) return String(raw);
  return parseInt(raw, 10);
};

class ConstituencyController {
  /**
   * GET /api/v1/constituencies?election_id=&active_only=
   * Public read: constituencies for an election (active by default).
   */
  async list(req, res, next) {
    try {
      const { election_id, active_only } = req.query;

      if (!election_id) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'election_id query parameter is required.',
        });
      }
      if (!isMongoOnly && isNaN(parseInt(election_id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'election_id query parameter is required.',
        });
      }

      const eid = resolveId(election_id);
      const election = await electionService.findById(eid);
      if (!election) {
        if (isMongoOnly) {
          // Mongo-only: return empty list instead of 404 so student ballot loads
          return res.json({ data: [], meta: { count: 0, electionId: eid } });
        }
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${election_id} not found`,
        });
      }

      const constituencies = await constituencyService.findByElectionId(
        eid,
        { activeOnly: active_only !== 'false' }
      );

      res.json({
        data: constituencies,
        meta: { count: constituencies.length, electionId: eid },
      });
    } catch (err) {
      if (isMongoOnly) {
        console.warn('[constituencyController] list Mongo-only fallback []:', err.message);
        const eid = req.query.election_id;
        const fallbackId = resolveId(eid);
        return res.json({ data: [], meta: { count: 0, electionId: fallbackId } });
      }
      next(err);
    }
  }

  /**
   * GET /api/v1/constituencies/:id/positions
   * Public read: positions for a constituency (the locked CR position).
   */
  async listPositions(req, res, next) {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid constituency ID',
        });
      }
      if (!isMongoOnly && isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid constituency ID',
        });
      }

      const cid = resolveId(id);
      const constituency = await constituencyService.findById(cid);
      if (!constituency) {
        if (isMongoOnly) {
          // Return empty positions list instead of 404 so ballot loads
          const positions = await positionService.findByConstituencyId(cid, {
            activeOnly: req.query.active_only !== 'false',
          });
          return res.json({ data: positions, meta: { count: positions.length, constituencyId: cid } });
        }
        return res.status(404).json({
          error: 'Not Found',
          message: `Constituency with ID ${id} not found`,
        });
      }

      const positions = await positionService.findByConstituencyId(cid, {
        activeOnly: req.query.active_only !== 'false',
      });

      res.json({
        data: positions,
        meta: { count: positions.length, constituencyId: cid },
      });
    } catch (err) {
      if (isMongoOnly) {
        console.warn('[constituencyController] listPositions Mongo-only fallback []:', err.message);
        const cid = req.params.id;
        return res.json({ data: [], meta: { count: 0, constituencyId: cid } });
      }
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/constituencies
   * Create a constituency (auto-creates its Class Representative position).
   */
  async create(req, res, next) {
    try {
      const { election_id, department, year, section, name } = req.body;

      if (!election_id || (!isMongoOnly && isNaN(parseInt(election_id)))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'election_id is required.',
        });
      }
      for (const field of ['department', 'year']) {
        if (!req.body[field] || String(req.body[field]).trim() === '') {
          return res.status(400).json({
            error: 'Validation Error',
            message: `${field} is required.`,
          });
        }
      }
      // section may be "" for section-less courses (MCA, MBA, BCom) — it must
      // be present as a string, but empty is valid.
      if (req.body.section === undefined || req.body.section === null || typeof req.body.section !== 'string') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'section is required.',
        });
      }

      const resolvedElectionId = resolveId(election_id);
      const election = await electionService.findById(resolvedElectionId);
      if (!election) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${election_id} not found`,
        });
      }

      if (election.status !== 'DRAFT' && election.status !== 'SCHEDULED') {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Cannot create constituencies when election is OPEN or CLOSED',
        });
      }

      const constituency = await constituencyService.create({
        electionId: resolvedElectionId,
        department,
        year,
        section,
        name,
      });

      // A new seat makes previously-approved candidates ballot-ready:
      // auto-place any approved-but-unplaced applications of this class.
      // Best-effort — never fails the creation.
      let autoPlaced = [];
      try {
        const outcome = await candidateAppService.placeUnplacedForElection(resolvedElectionId);
        autoPlaced = outcome.placed;
      } catch (err) {
        console.warn('create constituency: auto ballot placement failed', { electionId: election_id, code: err.code || err.message });
      }

      // Auto-match master candidates from data/candidates.json for this class.
      // Gender-preferring seat selection; never overwrites existing candidates.
      let matched = [];
      try {
        const outcome = await masterCandidateMatcher.matchClassForElection(
          resolvedElectionId,
          { department, year, section }
        );
        matched = outcome.placed || [];
      } catch (err) {
        console.warn('create constituency: master candidate auto-match failed', { electionId: election_id, code: err.code || err.message });
      }

      res.status(201).json({ data: constituency, meta: { autoPlaced, matched } });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'Conflict',
          message: 'A constituency with this department, year and section already exists in the election.',
        });
      }
      next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/constituencies/:id
   * Update name / is_active / voting_open (identity fields are immutable).
   *
   * `voting_open` is the per-class voting switch (Start/Stop Voting) and is a
   * runtime toggle: it is allowed even while the election is OPEN, because
   * CR votes only pass when the election is OPEN AND the class flag is true.
   * Structural changes (name / is_active) stay limited to DRAFT/SCHEDULED.
   */
  async update(req, res, next) {
    try {
      const { id } = req.params;
      const { name, is_active, voting_open } = req.body;

      if (!id || (!isMongoOnly && isNaN(parseInt(id)))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid constituency ID',
        });
      }

      const resolvedId = resolveId(id);
      const constituency = await constituencyService.findById(resolvedId);
      if (!constituency) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Constituency with ID ${id} not found`,
        });
      }

      const hasStructuralChange = name !== undefined || is_active !== undefined;
      if (hasStructuralChange && !(await constituencyService.canModify(resolvedId))) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Cannot modify constituency when election is OPEN or CLOSED',
        });
      }

      if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'name must be a non-empty string if provided',
        });
      }
      if (is_active !== undefined && typeof is_active !== 'boolean') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'is_active must be a boolean',
        });
      }
      if (voting_open !== undefined && typeof voting_open !== 'boolean') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'voting_open must be a boolean',
        });
      }

      const updated = await constituencyService.update(resolvedId, { name, is_active, voting_open });

      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/v1/admin/constituencies/:id
   * Deactivate a constituency (soft delete).
   */
  async remove(req, res, next) {
    try {
      const { id } = req.params;

      if (!id || (!isMongoOnly && isNaN(parseInt(id)))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid constituency ID',
        });
      }

      const resolvedId = resolveId(id);
      const constituency = await constituencyService.findById(resolvedId);
      if (!constituency) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Constituency with ID ${id} not found`,
        });
      }

      if (!(await constituencyService.canModify(resolvedId))) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Cannot deactivate constituency when election is OPEN or CLOSED',
        });
      }

      const updated = await constituencyService.deactivate(resolvedId);

      res.json({
        data: updated,
        message: 'Constituency deactivated.',
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new ConstituencyController();