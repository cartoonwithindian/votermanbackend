/**
 * GET /api/v1/admin/audit-logs — real audit trail (auth audit + election audit)
 *
 * Merges the two audit stores (auth_audit_logs for sign-in/auth events,
 * audit_logs for election/admin entity changes), newest first.
 * Mounted behind requireAdmin in app.js.
 */
const db = require('../db');

async function list(req, res) {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '150'), 10) || 150, 500);
    const [authLogs, entityLogs] = await Promise.all([
      db.query(
        `SELECT a.id, a.student_id, a.event AS action, a.ip_address, a.metadata, a.created_at,
                s.name AS user_name, s.role AS user_role
           FROM auth_audit_logs a
           LEFT JOIN students s ON s.id = a.student_id
          ORDER BY a.created_at DESC
          LIMIT $1`,
        [limit]
      ),
      db.query(
        `SELECT a.id, NULL::int AS student_id, a.action, a.ip_address,
                 jsonb_build_object('entityType', a.entity_type, 'entityId', a.entity_id, 'name', (a.metadata->>'name')) AS metadata,
                 a.created_at,
                 a.actor_id AS student_id_ref,
                 s.name AS user_name, s.role AS user_role
            FROM audit_logs a
            LEFT JOIN students s ON s.id = a.actor_id
           ORDER BY a.created_at DESC
           LIMIT $1`,
        [limit]
      ),
    ]);

    const merged = [...authLogs.rows, ...entityLogs.rows]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);

    return res.json({ data: { logs: merged } });
  } catch (error) {
    console.error('audit logs listing failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load audit logs.' } });
  }
}

module.exports = { list };
