function getPagination(req, fallbackLimit = 50) { const page = Math.max(parseInt(req.query.page || '1', 10), 1); const limit = Math.min(Math.max(parseInt(req.query.limit || fallbackLimit, 10), 1), 200); return { page, limit, offset: (page - 1) * limit }; }
module.exports = { getPagination };
