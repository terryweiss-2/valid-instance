/**
 * @module cache
 * Process-wide schema cache shared by every factory call.
 */
import { createHash } from 'node:crypto';

const SCHEMAS = new Map();
const IN_FLIGHT = new Map();

/**
 * Stringifies a value with sorted object keys so equal values give equal text.
 * @param {*} value Any JSON value.
 * @returns {string} Stable JSON text.
 */
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Computes the sha256 (hex) of a text.
 * @param {string} text The text.
 * @returns {string} Hex digest.
 */
export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Normalizes a URI into a cache key: the URI without its fragment.
 * @param {string} uri The URI.
 * @returns {string} The key.
 */
export function normalizeKey(uri) {
  try {
    const url = new URL(uri);
    url.hash = '';
    return url.href;
  } catch {
    return String(uri).replace(/#.*$/, '');
  }
}

/**
 * Looks up a schema in the cache.
 * @param {string} key Cache key.
 * @returns {*} The schema or undefined.
 */
export function getCached(key) {
  return SCHEMAS.get(key);
}

/**
 * Stores a schema in the cache.
 * @param {string} key Cache key.
 * @param {*} schema The schema.
 * @returns {void}
 */
export function setCached(key, schema) {
  SCHEMAS.set(key, schema);
}

/**
 * Returns the in-flight promise for a key, or starts one with `start`. Failed promises are dropped.
 * @param {string} key Cache key.
 * @param {() => Promise<*>} start Starts the work.
 * @returns {Promise<*>} Shared promise.
 */
export function dedupe(key, start) {
  let promise = IN_FLIGHT.get(key);
  if (!promise) {
    promise = start().finally(() => {
      IN_FLIGHT.delete(key);
    });
    IN_FLIGHT.set(key, promise);
  }
  return promise;
}

/**
 * Empties the process-wide schema cache. Primarily for tests.
 * @returns {void}
 */
export function clearSchemaCache() {
  SCHEMAS.clear();
  IN_FLIGHT.clear();
}
