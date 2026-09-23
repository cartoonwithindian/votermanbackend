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
const candidateAppService = require('../services/candidateApplicationService');
const jsonStore = require('../services/jsonCandidateStore');
const constituencyService = require('../services/constituencyService');
const positionService = require('../services/positionService');
const electionService = require('../services/electionService');
const { normalizeYear } = require('../utils/yearNormalizer');
const { pickCrSeat, isSingleGenderClass } = require('../utils/crSeat');
const { resolveId } = require('../utils/idResolver');
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
      const hasOwnClass = Boolean(u && u.department && u.year);
      const department = hasOwnClass ? u.department : req.query.department;
      const year = hasOwnClass ? u.year : req.query.year;
      const section = hasOwnClass ? (u.section ?? '') : req.query.section;

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

      const lookupId = resolveId(id);
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

      const pid = resolveId(positionId);
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
      const { name, description, image_url, bio, manifesto, application_id, display_order, department, year, section, gender } = req.body;

      if (!id || (!isMongoOnly && isNaN(parseInt(id)))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid candidate ID',
        });
      }

      // Application edits (admin candidates page lists applications): update the
      // candidate_applications content and mirror to the ballot candidates row.
      const applicationId = application_id != null && application_id !== '' ? application_id : null;
      const isApplicationEdit = applicationId !== null;

      let app = null;
      if (isApplicationEdit) {
        const targetId = resolveId(applicationId);
        app = await candidateAppService.getById(targetId);
      }
      if (app) {
        const status = await candidateService.getElectionStatusByPositionId(app.positionId);
        if (status === 'CLOSED') {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'Cannot modify candidate when election is CLOSED',
          });
        }
        const targetId = resolveId(app.id);
        const updated = await candidateAppService.adminUpdateContent(targetId, {
          fullName: name,
          bio: bio !== undefined ? bio : description,
          manifesto: manifesto !== undefined ? manifesto : description,
          profilePhotoUrl: image_url,
          gender,
          department,
          year,
          section,
        });
        return res.json({ data: updated });
      }

      // Check election state - allow modification unless CLOSED (server still
      // guards via requireAdmin on the routes).
      const status = await candidateService.getElectionStatusByPositionId(resolveId(id));
      if (status === 'CLOSED') {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Cannot modify candidate when election is CLOSED',
        });
      }

      const candidate = await candidateService.update(resolveId(id), {
        name,
        description: bio !== undefined ? bio : description,
        image_url,
        display_order,
        department,
        year,
        section,
        gender,
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
      await candidateService.invalidateCandidates();
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
      await candidateService.invalidateCandidates();
      return res.json({ success: true, deleted, message: deleted ? 'JSON override removed, DB is now active' : 'No JSON to delete' });
    } catch (e) { next(e); }
  }

  async addToBallot(req, res, next) {
    try {
      const raw = jsonStore.readJsonCandidates();
      if (!raw || !Array.isArray(raw) || raw.length === 0) {
        return res.status(400).json({ error: 'Bad Request', message: 'No JSON candidates uploaded. Upload a JSON file first.' });
      }

      let electionId = req.body.election_id;
      if (electionId === undefined || electionId === null || String(electionId).trim() === '') {
        const elections = await electionService.findAll({ limit: 100 });
        const sortKey = (e) => {
          const num = Number(e.id);
          if (Number.isFinite(num)) return num;
          const ts = new Date(e.created_at || e.createdAt || 0).getTime();
          return Number.isFinite(ts) ? ts : 0;
        };
        const pool = (elections || []).filter(e => ['OPEN', 'DRAFT', 'SCHEDULED'].includes(String(e.status || '').toUpperCase()));
        const target = pool.find(e => String(e.status || '').toUpperCase() === 'OPEN')
          || [...pool].sort((a, b) => sortKey(b) - sortKey(a))[0];
        if (!target) {
          return res.status(400).json({ error: 'Bad Request', message: 'No election available. Create or open an election first.' });
        }
        electionId = target.id;
      }

      const added = [];
      const skipped = [];
      const cohorts = {};
      const seatCounts = {};
      const cohortSpread = {};

      // Precompute single-gender (spread) per cohort so a class with only
      // girls / only boys tiles its candidates across both CR seats.
      for (const c of raw) {
        const department = String(c.department || c.Department || '').trim();
        const year = normalizeYear(c.year || c.Year) || '';
        const section = String(c.section ?? c.Section ?? '').trim();
        if (!department || !year) continue;
        const key = [String(electionId), department, year, section].join('|');
        if (!cohortSpread[key]) cohortSpread[key] = [];
        cohortSpread[key].push(c);
      }
      for (const key of Object.keys(cohortSpread)) {
        cohortSpread[key] = isSingleGenderClass(cohortSpread[key]);
      }

      for (const c of raw) {
        const name = String(c.fullName || c.FullName || c.name || '').trim();
        if (!name) {
          skipped.push({ name: c.fullName || c.FullName || c.name || 'Unknown', reason: 'invalid name' });
          continue;
        }

        const department = String(c.department || c.Department || '').trim();
        const year = normalizeYear(c.year || c.Year) || '';
        const section = String(c.section ?? c.Section ?? '').trim();
        if (!department || !year) {
          skipped.push({ name, reason: 'missing department or year' });
          continue;
        }

        const cohortKey = [String(electionId), department, year, section].join('|');
        if (!cohorts[cohortKey]) {
          let constituency = await constituencyService.findMatching({ electionId, department, year, section, activeOnly: false });
          if (!constituency) {
            constituency = await constituencyService.create({ electionId, department, year, section });
          }
          cohorts[cohortKey] = constituency || null;
          if (constituency && constituency.id) seatCounts[String(constituency.id)] = {};
        }
        const constituency = cohorts[cohortKey];
        if (!constituency || !constituency.id) {
          skipped.push({ name, reason: 'constituency unavailable' });
          continue;
        }

        const positions = await positionService.findByConstituencyId(constituency.id);
        const seat = this.getCrSeat(positions, c, {
          seatCounts: seatCounts[String(constituency.id)],
          spread: cohortSpread[cohortKey],
        });
        if (!seat || !seat.id) {
          skipped.push({ name, reason: 'invalid seat' });
          continue;
        }

        const canonical = await candidateService.findCanonicalCandidate({ name, department, year, section });
        if (canonical) {
          const seatId = String(seat.id);
          const linked = Array.from(new Set([
            String(canonical.position_id ?? canonical.positionId ?? ''),
            ...(Array.isArray(canonical.linked_positions) ? canonical.linked_positions.map(String) : []),
            ...(Array.isArray(canonical.linkedPositions) ? canonical.linkedPositions.map(String) : []),
          ]));
          if (linked.includes(seatId)) {
            skipped.push({ name, reason: 'already on ballot', position_id: seat.id, position_name: seat.name });
            continue;
          }
          if (positions.some(p => linked.includes(String(p.id)))) {
            skipped.push({ name, reason: 'already placed in election', position_id: seat.id, position_name: seat.name });
            continue;
          }
          const linkedDoc = await candidateService.linkToPosition(canonical.id, seat.id);
          if (!linkedDoc) {
            skipped.push({ name, reason: 'link failed', position_id: seat.id, position_name: seat.name });
            continue;
          }
          seatCounts[String(constituency.id)][seat.id] = (seatCounts[String(constituency.id)][seat.id] || 0) + 1;
          added.push({
            id: linkedDoc.id,
            name,
            position_id: seat.id,
            position_name: seat.name,
            constituency_id: constituency.id,
            department,
            year,
            section,
            gender: c.gender || null,
          });
          continue;
        }

        if (await candidateService.candidateExists(seat.id, name)) {
          skipped.push({ name, reason: 'already on ballot', position_id: seat.id, position_name: seat.name });
          continue;
        }

        const created = await candidateService.create({
          position_id: seat.id,
          name,
          description: c.manifesto || c.Manifesto || c.bio || '',
          image_url: c.profilePhotoUrl || c.profile_photo_url || c.image_url || '',
          department,
          year,
          section,
          gender: c.gender || null,
        });

        seatCounts[String(constituency.id)][seat.id] = (seatCounts[String(constituency.id)][seat.id] || 0) + 1;
        added.push({
          id: created.id,
          name,
          position_id: seat.id,
          position_name: seat.name,
          constituency_id: constituency.id,
          department,
          year,
          section,
          gender: c.gender || null,
        });
      }

      return res.json({
        success: true,
        added,
        skipped,
        addedCount: added.length,
        skippedCount: skipped.length,
        message: `Added ${added.length} candidates to ballot (${skipped.length} skipped)`,
      });
    } catch (e) { next(e); }
  }

  getCrSeat(positions, cand, opts) {
    return pickCrSeat(positions, cand, opts);
  }

  async removeBallotCandidate(req, res, next) {
    try {
      const { id } = req.params;
      if (!id || (!isMongoOnly && isNaN(parseInt(id)))) {
        return res.status(400).json({ error: 'Bad Request', message: 'Invalid candidate ID' });
      }
      const targetId = resolveId(id);
      const deleted = await candidateService.deleteById(targetId);
      if (!deleted) {
        return res.status(404).json({ error: 'Not Found', message: 'Candidate not found' });
      }
      return res.json({ success: true, message: 'Candidate removed from ballot' });
    } catch (e) { next(e); }
  }
}

module.exports = new CandidateController();
