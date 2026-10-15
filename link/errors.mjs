export class LinkError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "LinkError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

// Never reflect arbitrary exceptions, relay responses, URLs, keys, or input.
export function publicError(error) {
  if (error instanceof LinkError) {
    return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  return { code: "INTERNAL_ERROR", message: "The local Link client could not complete this operation." };
}

export function fields(value, allowed, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) {
    throw new LinkError("INVALID_INPUT", "Missing or unsupported request fields.");
  }
}
