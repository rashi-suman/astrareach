const counters = { total: 0, byStatus: {}, byPath: {} };

function inc(map, key) { map[key] = (map[key] || 0) + 1; }

function middleware(req, res, next) {
  res.on('finish', () => {
    counters.total += 1;
    inc(counters.byStatus, String(res.statusCode));
    inc(counters.byPath, req.method + ' ' + (req.route?.path || req.path));
  });
  next();
}

function snapshot() { return JSON.parse(JSON.stringify(counters)); }

module.exports = { middleware, snapshot };
