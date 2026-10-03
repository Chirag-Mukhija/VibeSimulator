// Single place that turns thrown errors into HTTP responses
module.exports = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;

  if (statusCode === 500) {
    console.error(err);
  }

  res.status(statusCode).json({ error: err.message || 'Internal server error' });
};
