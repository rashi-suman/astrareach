const router = require('express').Router();
const c = require('../controllers/segmentController');
const { requirePermission } = require('../middleware/rbac');

router.get('/',           requirePermission('segments.view'),   c.index);
router.get('/new',        requirePermission('segments.create'), c.newPage);
router.post('/',          requirePermission('segments.create'), c.create);
router.post('/preview',   requirePermission('segments.view'),   c.preview);

// Safety net: handle _method=DELETE / _method=PUT from HTML forms
router.post('/:id', (req, res, next) => {
  const method = (req.body._method || '').toUpperCase();
  if (method === 'DELETE') {
    req.method = 'DELETE';
    return router.handle(req, res, next);
  }
  if (method === 'PUT' || method === 'PATCH') {
    req.method = 'PUT';
    return router.handle(req, res, next);
  }
  next();
});

router.get('/:id',        requirePermission('segments.view'),   c.detail);
router.put('/:id',        requirePermission('segments.edit'),   c.update);
router.delete('/:id',     requirePermission('segments.delete'), c.remove);
router.post('/:id/refresh', requirePermission('segments.edit'), c.refresh);
router.get('/:id/contacts', requirePermission('segments.view'), c.contacts);
router.get('/:id/export',   requirePermission('segments.view'), c.exportCSV);

module.exports = router;
