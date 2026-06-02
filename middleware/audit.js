'use strict';
const { auditLog } = require('./rbac');

/**
 * Convenience re-export so routes can do:
 *   const { logAction } = require('../middleware/audit');
 *   router.post('/:id/start', logAction('campaign.start', 'campaign'), controller.start);
 */
function logAction(action, resourceType) {
  return auditLog(action, resourceType);
}

module.exports = { logAction };
