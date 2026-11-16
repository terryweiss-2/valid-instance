/**
 * @module loader
 * Resolves schemas by URI: pre-seeded cache, local `file:` files, resolver hook or guarded network fetch.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dedupe, getCached, normalizeKey, setCached, sha256, stableStringify } from './cache.js';
import { InvalidJsonSchemaError, JsonSchemaCommError } from './errors.js';
import { guardedFetch, sanitizeUrl } from './net.js';

/**
 * Collects the `$ref` strings of a schema.
 * @param {*} node Schema node.
 * @param {string[]} out Accumulator.
 * @returns {string[]} The refs.
 */
function collectRefs(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectRefs(n, out));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        out.push(value);
      } else {
        collectRefs(value, out);
      }
    }
  }
  return out;
}

/**
 * Collects the absolute `$id` strings of a schema.
 * @param {*} node Schema node.
 * @param {string[]} out Accumulator.
 * @returns {string[]} The ids.
 */
function collectIds(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectIds(n, out));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$id' && typeof value === 'string') {
        out.push(value);
      } else {
        collectIds(value, out);
      }
    }
  }
  return out;
}

/**
 * Builds a policy error.
 * @param {string} message Message.
 * @param {string} [code] Code.
 * @returns {JsonSchemaCommError} The error.
 */
function blocked(message, code = 'REMOTE_REF_BLOCKED') {
  return new JsonSchemaCommError(message, { code });
}

/**
 * Parses and vets schema text received from a remote origin.
 * @param {string} uri Where it came from.
 * @param {string} text The text.
 * @returns {object|boolean} The schema.
 */
function parseRemote(uri, text) {
  let schema;
  try {
    schema = JSON.parse(text);
  } catch (cause) {
    throw new InvalidJsonSchemaError(`Response is not JSON: ${sanitizeUrl(uri)}`, { code: 'SCHEMA_PARSE', cause });
  }
  if (schema === null || (typeof schema !== 'object' && typeof schema !== 'boolean') || Array.isArray(schema)) {
    throw new InvalidJsonSchemaError(`Response is not a schema: ${sanitizeUrl(uri)}`, { code: 'SCHEMA_INVALID' });
  }
  return schema;
}

/**
 * Applies the content rules for a schema fetched from a URL.
 * @param {string} uri Fetch URI.
 * @param {*} schema The schema.
 * @returns {void}
 */
function vetFetched(uri, schema) {
  const host = new URL(uri).host;
  for (const id of collectIds(schema)) {
    let idUrl;
    try {
      idUrl = new URL(id, uri);
    } catch {
      continue;
    }
    if (idUrl.host !== host) {
      throw new InvalidJsonSchemaError(`Schema ${sanitizeUrl(uri)} claims a foreign $id`, { code: 'SCHEMA_INVALID' });
    }
  }
  for (const ref of collectRefs(schema)) {
    if (/^(file|data):/i.test(ref)) {
      throw new InvalidJsonSchemaError(`Schema ${sanitizeUrl(uri)} references a ${ref.split(':')[0]}: URI`, {
        code: 'SCHEMA_INVALID'
      });
    }
  }
}

/**
 * Creates a loader bound to the options of one factory call.
 * @param {object} remote Normalized remoteRefs options.
 * @param {boolean} allowFiles Whether `file:` references may be read from disk.
 * @returns {{load: (uri: string) => Promise<*>, noteRefs: (schema: *, base: string, depth: number) => void}} Loader.
 */
export function createLoader(remote, allowFiles) {
  const requested = new Set();
  const depths = new Map();

  /**
   * Records the depth of the external refs of a schema and enforces `maxDepth`.
   * @param {*} schema The schema.
   * @param {string} base Base URI.
   * @param {number} depth Depth of the schema itself.
   * @returns {void}
   */
  function noteRefs(schema, base, depth) {
    for (const ref of collectRefs(schema)) {
      let url;
      try {
        url = new URL(ref, base);
      } catch {
        continue;
      }
      const key = normalizeKey(url.href);
      if (!depths.has(key) || depths.get(key) > depth + 1) {
        depths.set(key, depth + 1);
      }
      if (depth + 1 > remote.maxDepth) {
        throw blocked(`$ref chain deeper than maxDepth (${remote.maxDepth})`);
      }
    }
  }

  /**
   * Fetches, vets and caches a remote schema.
   * @param {string} key Normalized URI.
   * @returns {Promise<*>} The schema.
   */
  async function fetchRemote(key) {
    console.warn(`valid-instance: fetching remote schema ${sanitizeUrl(key)}`);
    let text;
    if (remote.resolver) {
      const result = await remote.resolver(key);
      text = typeof result === 'string' ? result : JSON.stringify(result);
    } else {
      text = await guardedFetch(key, remote);
    }
    const expected = remote.integrity[key];
    if (expected && sha256(text).toLowerCase() !== String(expected).toLowerCase()) {
      throw blocked(`Integrity mismatch for ${sanitizeUrl(key)}`, 'INTEGRITY_MISMATCH');
    }
    const schema = parseRemote(key, text);
    vetFetched(key, schema);
    setCached(key, schema);
    return schema;
  }

  /**
   * Reads a local schema file.
   * @param {string} key `file:` URI.
   * @returns {Promise<*>} The schema.
   */
  async function loadFile(key) {
    if (!allowFiles) {
      throw blocked(`file: references are not allowed here: ${sanitizeUrl(key)}`);
    }
    let text;
    try {
      text = await readFile(fileURLToPath(key), 'utf8');
    } catch (cause) {
      throw new JsonSchemaCommError(`Could not read ${sanitizeUrl(key)}`, { code: 'NETWORK', cause });
    }
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new InvalidJsonSchemaError(`File is not JSON: ${sanitizeUrl(key)}`, { code: 'SCHEMA_PARSE', cause });
    }
  }

  /**
   * Loads a schema by URI.
   * @param {string} uri Absolute URI.
   * @returns {Promise<*>} The schema, with `$id` defaulted to the URI.
   */
  async function load(uri) {
    const key = normalizeKey(uri);
    const depth = depths.get(key) ?? 1;
    if (depth > remote.maxDepth) {
      throw blocked(`$ref chain deeper than maxDepth (${remote.maxDepth})`);
    }
    let schema = getCached(key);
    if (schema === undefined) {
      schema = await loadUncached(key);
    }
    noteRefs(schema, key, depth);
    return schema && typeof schema === 'object' && !schema.$id ? { ...schema, $id: key } : schema;
  }

  /**
   * Loads a schema that is not in the cache.
   * @param {string} key Normalized URI.
   * @returns {Promise<*>} The schema.
   */
  function loadUncached(key) {
    if (key.startsWith('file:')) {
      return loadFile(key);
    }
    if (!/^https?:/i.test(key)) {
      throw blocked(`Cannot load ${sanitizeUrl(key)}`);
    }
    if (!remote.enabled) {
      throw blocked(`Remote refs are disabled; ${sanitizeUrl(key)} is not pre-seeded`);
    }
    if (!requested.has(key) && requested.size >= remote.maxRefs) {
      throw blocked(`More than maxRefs (${remote.maxRefs}) remote schemas requested`);
    }
    requested.add(key);
    return dedupe(key, () => fetchRemote(key));
  }

  return { load, noteRefs };
}

/**
 * Seeds the process-wide cache.
 * @param {{[uri: string]: object}} schemas Schemas by URI.
 * @returns {void}
 */
export function seedCache(schemas) {
  for (const [uri, schema] of Object.entries(schemas)) {
    setCached(normalizeKey(uri), schema);
  }
}

/**
 * Returns a deduplicated (cached) instance of an object or text schema.
 * @param {object} schema A parsed schema.
 * @returns {object} The cached equivalent.
 */
export function dedupeSchema(schema) {
  const key = `sha256:${sha256(stableStringify(schema))}`;
  const found = getCached(key);
  if (found) {
    return found;
  }
  setCached(key, schema);
  return schema;
}
