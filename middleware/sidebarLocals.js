const db = require('../config/db');

/**
 * Injects sidebar stats (totalContacts, activeCampaigns) into res.locals
 * for every authenticated request, so partials always have the data.
 */
module.exports = async function sidebarLocals(req, res, next) {
  const p = req.path || '';
  res.locals.sidebarPath = p;
  res.locals.waNavPath = p; // alias for WA submenu / legacy
  if (!req.user) return next();
  try {
    const [cRes, aRes] = await Promise.all([
      db.query('SELECT COUNT(*)::int AS count FROM contacts'),
      db.query("SELECT COUNT(*)::int AS count FROM campaigns WHERE status='active'"),
    ]);
    res.locals.totalContacts = cRes.rows[0].count;
    res.locals.activeCampaigns = aRes.rows[0].count;
  } catch (_) {
    res.locals.totalContacts = 0;
    res.locals.activeCampaigns = 0;
  }
  next();
};
