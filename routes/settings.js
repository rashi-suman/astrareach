'use strict';
const express = require('express');
const router  = express.Router();
const c       = require('../controllers/settingsController');
const { requirePermission } = require('../middleware/rbac');
const { logAction }         = require('../middleware/audit');

router.get('/',  c.index);
router.post('/', c.save);

// Field-level permissions (superadmin only)
router.get('/field-permissions',
  requirePermission('permissions.manage'),
  c.fieldPermissionsIndex,
);
router.post('/field-permissions',
  requirePermission('permissions.manage'),
  logAction('field_permissions.update', 'settings'),
  c.saveFieldPermissions,
);

// User data scopes (superadmin only)
router.get('/user-scopes',
  requirePermission('permissions.manage'),
  c.userScopesIndex,
);
router.post('/user-scopes/:userId',
  requirePermission('permissions.manage'),
  logAction('user_scope.update', 'user'),
  c.saveUserScope,
);

module.exports = router;
