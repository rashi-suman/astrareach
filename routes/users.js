'use strict';
const express = require('express');
const router  = express.Router();
const c       = require('../controllers/userController');
const { requirePermission } = require('../middleware/rbac');
const { logAction }         = require('../middleware/audit');

router.get('/',              requirePermission('users.view'),   c.index);
router.get('/new',           requirePermission('users.create'), c.newForm);
router.post('/',             requirePermission('users.create'), logAction('user.create','user'), c.create);
router.get('/:id',           requirePermission('users.view'),   c.show);
router.get('/:id/edit',      requirePermission('users.edit'),   c.editForm);
router.put('/:id',           requirePermission('users.edit'),   logAction('user.update','user'), c.update);
router.delete('/:id',        requirePermission('users.delete'), logAction('user.delete','user'), c.destroy);
router.post('/:id/reset-password', requirePermission('users.edit'), logAction('user.password_reset','user'), c.resetPassword);
router.get('/:id/audit-log', requirePermission('audit.view'),   c.auditLogView);

module.exports = router;
