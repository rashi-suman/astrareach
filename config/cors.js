const ALLOW = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

module.exports = function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && (ALLOW.includes('*') || ALLOW.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};
