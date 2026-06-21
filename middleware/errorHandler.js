module.exports = function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  const payload = { error: err.message || 'Internal Server Error', requestId: req.id };
  if (process.env.NODE_ENV !== 'production') payload.stack = err.stack;
  res.status(status).json(payload);
};
