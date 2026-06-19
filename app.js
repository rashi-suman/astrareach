require('dotenv').config();
const express      = require('express');
const path         = require('path');
const session      = require('express-session');
const MySQLStore   = require('express-mysql-session')(session);
const methodOverride = require('method-override');
const passport     = require('./config/passport');
const flash        = require('express-flash');
const helmet       = require('helmet');
const compression  = require('compression');
const db           = require('./config/db');
const { requireLogin } = require('./middleware/auth');
const { requireAuth }  = require('./middleware/rbac');

const app = express();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Security + compression
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

// Tracking routes need raw body for webhook signature verification — mount BEFORE json/urlencoded
app.use('/t', require('./routes/tracking'));

// Body parsers
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

// Session
app.use(session({
  store: new MySQLStore({
    createDatabaseTable: true,
    schema: { tableName: 'session', columnNames: { session_id: 'sid', expires: 'expire', data: 'sess' } },
  }, db.pool),
  secret:            process.env.SESSION_SECRET || 'change-me-in-production',
  resave:            false,
  saveUninitialized: false,
  cookie:            { maxAge: 1000 * 60 * 60 * 24 * 7, httpOnly: true },
}));

app.use(flash());
app.use(passport.initialize());
app.use(passport.session());

// Global template locals
app.use((req, res, next) => {
  res.locals.user            = req.user;
  res.locals.title           = 'AstraReach';
  res.locals.page            = 'dashboard';
  res.locals.breadcrumbs     = [];
  res.locals.totalContacts   = 0;
  res.locals.activeCampaigns = 0;
  // Make flash messages available in every view automatically
  res.locals.flash_success = req.flash ? req.flash('success') : [];
  res.locals.flash_error   = req.flash ? req.flash('error')   : [];
  res.locals.flash_info    = req.flash ? req.flash('info')    : [];
  res.locals.flash_warning = req.flash ? req.flash('warning') : [];
  next();
});
app.use(require('./middleware/sidebarLocals'));

// Auth routes (no auth required)
app.use('/', require('./routes/auth'));

// Legacy webhooks route (keep for backward compat)
app.use('/webhooks', require('./routes/webhooks'));

// Protected routes — use requireAuth (RBAC-aware) which falls back to requireLogin behaviour
const protect = [requireLogin, requireAuth];

app.use('/dashboard',  ...protect, require('./routes/dashboard'));
app.use('/contacts',   ...protect, require('./routes/contacts'));
app.use('/segments',   ...protect, require('./routes/segments'));
app.use('/campaigns',  ...protect, require('./routes/campaigns'));
app.use('/templates',  ...protect, require('./routes/templates'));
app.use('/analytics',  ...protect, require('./routes/analytics'));
app.use('/settings',   ...protect, require('./routes/settings'));
app.use('/users',      ...protect, require('./routes/users'));
app.use('/enrichment', ...protect, require('./routes/enrichment'));
app.use('/whatsapp',  ...protect, require('./routes/whatsapp'));

// WhatsApp webhooks (no auth — Meta/Twilio call these directly)
app.use('/webhooks/whatsapp', require('./routes/waWebhooks'));

app.get('/', (req, res) => res.redirect('/dashboard'));

// Error handler
app.use((err, req, res, next) => {
  console.error('[app error]', err.message);
  if (req.xhr || req.accepts('json') === 'json') {
    return res.status(500).json({ error: err.message });
  }
  res.status(500).send(`<pre>${err.message}</pre>`);
});

module.exports = app;
