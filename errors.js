/**
 * @module errors
 * Error classes thrown by valid-instance. All of them extend {@link ValidInstanceError}.
 */

/**
 * Base class of every error raised by this library.
 */
export class ValidInstanceError extends Error {
  /**
   * @param {string} message Human readable message. Never contains property values.
   * @param {object} [details] Extra fields attached to the error.
   * @param {string} [details.code] Machine readable code.
   * @param {string} [details.property] JSON pointer of the failing property.
   * @param {string} [details.schemaPath] Path of the failing keyword in the schema.
   * @param {string} [details.expected] Expected type or constraint.
   * @param {string} [details.received] Type (not value) that was received.
   * @param {*} [details.value] The offending value. Only attached to the object, never logged.
   * @param {Error} [details.cause] Underlying error.
   * @param {object[]} [details.issues] All validation issues.
   */
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = new.target.name;
    this.code = details.code;
    this.property = details.property;
    this.schemaPath = details.schemaPath;
    this.expected = details.expected;
    this.received = details.received;
    this.value = details.value;
    this.issues = details.issues;
  }
}

/** Thrown when `initial` or `replaceWith()` data fails validation. */
export class InitializationError extends ValidInstanceError {}

/** Thrown when a live mutation fails validation and `onlyWarn` is false. */
export class InvalidValueError extends ValidInstanceError {}

/** Thrown when a schema cannot be parsed, is not a valid schema, or breaks policy rules. */
export class InvalidJsonSchemaError extends ValidInstanceError {}

/** Thrown when a remote schema could not be fetched (network, timeout, size, redirect, policy). */
export class JsonSchemaCommError extends ValidInstanceError {}

/**
 * Writes an error to the console when enabled, then returns it so the caller can throw it.
 * @param {ValidInstanceError} error The error.
 * @param {boolean} log Whether `console.error()` should be used.
 * @returns {ValidInstanceError} The same error.
 */
export function logAndReturn(error, log) {
  if (log) {
    console.error(`${error.name} [${error.code}]: ${error.message}`);
  }
  return error;
}
