/**
 * Candidate Application Controller
 * HTTP request handling for candidate application workflow
 */

const candidateAppService = require('../services/candidateApplicationService');

class CandidateApplicationController {
  /**
   * POST /api/candidates/apply
   * Submit a new candidate application
   */
  async apply(req, res, next) {
    try {
      const studentId = req.user.studentId;
      const applicationData = req.body;

      const category = String(applicationData.category || 'CR').trim().toUpperCase();
      if (category !== 'CR' && category !== 'CLASS_REPRESENTATIVE') {
        return res.status(400).json({
          success: false,
          message: 'Invalid category. Only Class Representative applications are accepted.',
        });
      }

      // Validate required fields. CR applications require a section so the
      // constituency seat can be resolved at approval.
      const requiredFields = [
        'fullName', 'enrollmentNumber', 'department', 'year', 'section', 'email', 'phone',
        'bio', 'manifesto', 'age', 'dateOfBirth', 'gender', 'aadharNumber'
      ];

      for (const field of requiredFields) {
        if (!applicationData[field] || String(applicationData[field]).trim() === '') {
          return res.status(400).json({
            success: false,
            message: `Missing required field: ${field}`,
          });
        }
      }

      // Email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(applicationData.email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format',
        });
      }

      // Phone validation
      const phoneRegex = /^[0-9]{10,15}$/;
      const cleanPhone = applicationData.phone.replace(/\D/g, '');
      if (!phoneRegex.test(cleanPhone)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid phone number format',
        });
      }

      const application = await candidateAppService.create(applicationData, studentId);

      return res.status(201).json({
        success: true,
        message: 'Application submitted successfully',
        application,
      });
    } catch (error) {
      if (error.code === 'DUPLICATE_ENROLLMENT') {
        return res.status(409).json({
          success: false,
          message: error.message,
        });
      }
      if (error.code === 'INVALID_POSITION') {
        return res.status(400).json({
          success: false,
          message: error.message,
        });
      }
      next(error);
    }
  }

  /**
   * GET /api/candidates/me/application
   * Get current student's application
   */
  async getMyApplication(req, res, next) {
    try {
      const studentId = req.user.studentId;
      const application = await candidateAppService.getByStudentId(studentId);

      if (!application) {
        return res.status(404).json({
          success: false,
          message: 'No application found',
        });
      }

      return res.json({
        success: true,
        application,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/candidates/me/access
   * Check candidate's access level based on application status
   */
  async getAccess(req, res, next) {
    try {
      const studentId = req.user.studentId;
      const application = await candidateAppService.getByStudentId(studentId);

      if (!application) {
        return res.json({
          success: true,
          status: null,
          isApproved: false,
          canAccessCandidatePortal: false,
          hasApplication: false,
        });
      }

      const isApproved = application.status === 'approved';

      return res.json({
        success: true,
        status: application.status,
        isApproved,
        canAccessCandidatePortal: isApproved,
        hasApplication: true,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/candidates/me/profile
   * Update candidate profile (bio, manifesto, photo) after approval
   * Also allows updates when status is changes_requested
   */
  async updateProfile(req, res, next) {
    try {
      const studentId = req.user.studentId;
      const { profilePhotoUrl, bio, manifesto } = req.body;

      const application = await candidateAppService.getByStudentId(studentId);

      if (!application) {
        return res.status(404).json({
          success: false,
          message: 'No application found',
        });
      }

      // Can only update if approved or changes_requested
      if (application.status !== 'approved' && application.status !== 'changes_requested') {
        return res.status(403).json({
          success: false,
          message: 'Application must be approved before updating profile',
        });
      }

      const updates = {};
      if (profilePhotoUrl !== undefined) updates.profilePhotoUrl = profilePhotoUrl;
      if (bio !== undefined) updates.bio = bio;
      if (manifesto !== undefined) updates.manifesto = manifesto;

      const updated = await candidateAppService.updateProfile(application.id, updates, studentId);

      return res.json({
        success: true,
        message: 'Profile updated successfully',
        application: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/candidates/me/resubmit
   * Resubmit application after changes requested
   */
  async resubmit(req, res, next) {
    try {
      const studentId = req.user.studentId;
      const { profilePhotoUrl, bio, manifesto } = req.body;

      const application = await candidateAppService.getByStudentId(studentId);

      if (!application) {
        return res.status(404).json({
          success: false,
          message: 'No application found',
        });
      }

      if (application.status !== 'changes_requested') {
        return res.status(400).json({
          success: false,
          message: 'Application is not in changes_requested status',
        });
      }

      const updated = await candidateAppService.resubmit(application.id, {
        profilePhotoUrl,
        bio,
        manifesto,
      });

      return res.json({
        success: true,
        message: 'Application resubmitted for review',
        application: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  // =====================================================
  // ADMIN ENDPOINTS
  // =====================================================

  /**
   * GET /api/admin/candidates
   * List all candidate applications for admin
   */
  async listForAdmin(req, res, next) {
    try {
      const { status, department, positionId, search } = req.query;

      const applications = await candidateAppService.listForAdmin({
        status,
        department,
        positionId,
        search,
      });

      return res.json({
        success: true,
        candidates: applications,
        count: applications.length,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/admin/candidates/:id
   * Get single application details for admin review
   */
  async getForAdmin(req, res, next) {
    try {
      const { id } = req.params;
      const application = await candidateAppService.getById(id);

      if (!application) {
        return res.status(404).json({
          success: false,
          message: 'Application not found',
        });
      }

      return res.json({
        success: true,
        application,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/admin/candidates/:id/approve
   * Approve a candidate application
   */
  async approve(req, res, next) {
    try {
      const { id } = req.params;
      const adminId = req.user.studentId;

      const application = await candidateAppService.getById(id);

      if (!application) {
        return res.status(404).json({
          success: false,
          message: 'Application not found',
        });
      }

      if (application.status !== 'under_review') {
        return res.status(400).json({
          success: false,
          message: 'Application is not under review',
        });
      }

      const updated = await candidateAppService.approve(id, adminId, req.body);

      return res.json({
        success: true,
        message: 'Candidate application approved.',
        application: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/admin/candidates/:id/reject
   * Reject a candidate application
   */
  async reject(req, res, next) {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const adminId = req.user.studentId;

      if (!reason || reason.trim() === '') {
        return res.status(400).json({
          success: false,
          message: 'Rejection reason is required',
        });
      }

      const application = await candidateAppService.getById(id);

      if (!application) {
        return res.status(404).json({
          success: false,
          message: 'Application not found',
        });
      }

      if (application.status !== 'under_review') {
        return res.status(400).json({
          success: false,
          message: 'Application is not under review',
        });
      }

      const updated = await candidateAppService.reject(id, reason, adminId);

      return res.json({
        success: true,
        message: 'Candidate application rejected.',
        application: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/admin/candidates/:id/request-changes
   * Request changes to a candidate application
   */
  async requestChanges(req, res, next) {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const adminId = req.user.studentId;

      if (!reason || reason.trim() === '') {
        return res.status(400).json({
          success: false,
          message: 'Reason for requested changes is required',
        });
      }

      const application = await candidateAppService.getById(id);

      if (!application) {
        return res.status(404).json({
          success: false,
          message: 'Application not found',
        });
      }

      if (application.status !== 'under_review') {
        return res.status(400).json({
          success: false,
          message: 'Application is not under review',
        });
      }

      const updated = await candidateAppService.requestChanges(id, reason, adminId);

      return res.json({
        success: true,
        message: 'Changes requested from candidate.',
        application: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/admin/candidates/approved - List all approved candidates
   * For admin position management with class/section/CR filtering
   */
  async listApproved(req, res, next) {
    try {
      const { position_id, department, section } = req.query;

      const candidates = await candidateAppService.findApprovedForAdmin({
        positionId: position_id ? parseInt(position_id) : undefined,
        department,
        section,
      });

      return res.json({
        data: candidates,
        meta: { count: candidates.length },
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new CandidateApplicationController();
