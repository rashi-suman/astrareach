const router = require('express').Router();
const c = require('../controllers/webhookController');
router.get('/open/:campaignContactId', c.open);
router.get('/click/:campaignContactId', c.click);
router.get('/unsubscribe/:campaignContactId', c.unsubscribe);
router.post('/resend', c.resend);
module.exports = router;
