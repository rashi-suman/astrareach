module.exports = {
  loginPage: (req, res) => {
    // Pass flash messages so the login page toasts can show them
    const messages = {
      error:   req.flash ? req.flash('error')   : [],
      success: req.flash ? req.flash('success') : [],
      info:    req.flash ? req.flash('info')    : [],
    };
    res.render('auth/login', { title: 'Login', page: 'login', breadcrumbs: [], messages });
  },

  logout: (req, res) => {
    req.logout(() => {
      req.flash && req.flash('success', 'You have been logged out');
      req.session.destroy(() => res.redirect('/login'));
    });
  },
};
