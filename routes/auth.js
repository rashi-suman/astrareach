const router  = require('express').Router();
const passport = require('passport');
const c        = require('../controllers/authController');

router.get('/login', c.loginPage);

router.post('/login',
  passport.authenticate('local', {
    successRedirect: '/dashboard',
    failureRedirect: '/login',
    failureFlash:    true,   // passport sets req.flash('error') on failure
  })
);

router.post('/logout', c.logout);

module.exports = router;
