class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function notFound(message = 'resource not found') {
  return new HttpError(404, message);
}

function badRequest(message, details) {
  return new HttpError(400, message, details);
}

module.exports = { HttpError, notFound, badRequest };
