/**
 * Position Controller
 * HTTP request handling for position management
 */

const positionService = require('../services/positionService');
const constituencyService = require('../services/constituencyService');

class PositionController {
  /**
   * GET /api/v1/positions/recommended
   */
  async getRecommended(req, res, next) {
    try {
      const recommended = positionService.getRecommendedPositions();
      res.json({ data: recommended });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/positions - List all positions
   */
  async listAll(req, res, next) {
    try {
      const { active_only, limit, offset } = req.query;

      const positions = await positionService.findAll({
        activeOnly: active_only !== 'false',
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
      });

      res.json({
        data: positions,
        meta: {
          count: positions.length,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/constituencies/:constituencyId/positions
   */
  async listForConstituency(req, res, next) {
    try {
      const { constituencyId } = req.params;
      const { active_only, limit, offset } = req.query;

      if (!constituencyId || isNaN(parseInt(constituencyId))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid constituency ID',
        });
      }

      // Verify constituency exists
      const constituency = await constituencyService.findById(parseInt(constituencyId));
      if (!constituency) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Constituency with ID ${constituencyId} not found`,
        });
      }

      const positions = await positionService.findByConstituencyId(parseInt(constituencyId), {
        activeOnly: active_only !== 'false',
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
      });

      res.json({
        data: positions,
        meta: {
          count: positions.length,
          constituencyId: parseInt(constituencyId),
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/constituencies/:constituencyId/positions
   */
  async createForConstituency(req, res, next) {
    try {
      const { constituencyId } = req.params;
      const { name, description, display_order } = req.body;

      if (!constituencyId || isNaN(parseInt(constituencyId))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid constituency ID',
        });
      }

      // Validate required fields
      if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'name is required and must be a non-empty string',
        });
      }

      if (name.length > 255) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'name must be 255 characters or less',
        });
      }

      if (description && description.length > 5000) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'description must be 5000 characters or less',
        });
      }

      if (display_order !== undefined && (typeof display_order !== 'number' || !Number.isInteger(display_order))) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'display_order must be an integer if provided',
        });
      }

      // Verify constituency exists
      const constituency = await constituencyService.findById(parseInt(constituencyId));
      if (!constituency) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Constituency with ID ${constituencyId} not found`,
        });
      }

      // Check election status
      const canCreate = await positionService.canModify(null, parseInt(constituencyId));
      if (!canCreate) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Cannot create position when election is OPEN or CLOSED',
        });
      }

      const position = await positionService.create({
        constituency_id: parseInt(constituencyId),
        name: name.trim(),
        description: description?.trim() || null,
        display_order: display_order !== undefined ? display_order : 0,
      });

      res.status(201).json({ data: position });
    } catch (err) {
      // Handle duplicate name constraint
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'Conflict',
          message: `A position with name '${req.body.name}' already exists in this constituency`,
        });
      }
      next(err);
    }
  }

  /**
   * GET /api/v1/positions/:id
   */
  async get(req, res, next) {
    try {
      const { id } = req.params;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid position ID',
        });
      }

      const position = await positionService.findById(parseInt(id));

      if (!position) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Position with ID ${id} not found`,
        });
      }

      res.json({ data: position });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/positions/:id
   */
  async update(req, res, next) {
    try {
      const { id } = req.params;
      const { name, description, display_order } = req.body;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid position ID',
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

      // Validate display_order if provided
      if (display_order !== undefined && (typeof display_order !== 'number' || !Number.isInteger(display_order))) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'display_order must be an integer if provided',
        });
      }

      // Check if position exists
      const existingPosition = await positionService.findById(parseInt(id));
      if (!existingPosition) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Position with ID ${id} not found`,
        });
      }

      // Check election status - only allow modification in DRAFT/SCHEDULED
      const canModify = await positionService.canModify(parseInt(id));
      if (!canModify) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Cannot modify position when election is OPEN or CLOSED',
        });
      }

      const position = await positionService.update(parseInt(id), {
        name,
        description,
        display_order,
      });

      res.json({ data: position });
    } catch (err) {
      // Handle duplicate name constraint
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'Conflict',
          message: `A position with name '${req.body.name}' already exists in this constituency`,
        });
      }
      next(err);
    }
  }
}

module.exports = new PositionController();
