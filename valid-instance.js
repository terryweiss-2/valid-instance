/**
 * @module valid-instance
 * Factory for typed objects: objects whose properties are validated against a JSON Schema.
 */
import Ajv07 from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import checkType from 'check-type';
import { dedupeSchema, createLoader, seedCache } from './loader.js';
import {
  InitializationError, InvalidJsonSchemaError, InvalidValueError, ValidInstanceError, logAndReturn
} from './errors.js';

const check = checkType.init();
const RESERVED = ['validate', 'replaceWith'];

const DEFAULT_REMOTE = {
  enabled: false,
  allowList: [],
  protocols: ['https:'],
  timeoutMs: 5000,
  maxBytes: 1048576,
  maxRedirects: 0,
  maxRefs: 50,
  maxDepth: 10,
  allowPrivateHosts: [],
  resolver: undefined,
  schemas: {},
  integrity: {}
};

const DEFAULTS = { validateOnInit: true, liveValidate: false, onlyWarn: false, logErrorToConsole: true };

/**
 * Throws a TypeError when a value does not have one of the expected types.
 * @param {string} label Name used in the message.
 * @param {*} value The value.
 * @param {...string} types Accepted `check-type` type names.
 * @returns {void}
 */
function expectType(label, value, ...types) {
  if (!types.some((type) => check(value).is(type))) {
    throw new TypeError(`${label} must be of type ${types.join(' or ')}`);
  }
}

/**
 * Tells whether a value is a plain (non-array, non-null, non-function) object.
 * @param {*} value The value.
 * @returns {boolean} True for plain objects.
 */
function isPlain(value) {
  return check(value).is('object') && !check(value).is('array') && !check(value).is('function') && value !== null;
}

/**
 * Validates and completes the user supplied options.
 * @param {object} [options] User options.
 * @returns {object} Options with defaults applied.
 */
function normalizeOptions(options = {}) {
  if (!isPlain(options)) {
    throw new TypeError('options must be an object');
  }
  const result = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (options[key] !== undefined) {
      expectType(`options.${key}`, options[key], 'boolean');
      result[key] = options[key];
    }
  }
  result.remoteRefs = normalizeRemote(options.remoteRefs);
  return result;
}

/**
 * Validates and completes the `remoteRefs` options.
 * @param {object} [input] User supplied `remoteRefs`.
 * @returns {object} Complete remote refs options.
 */
function normalizeRemote(input = {}) {
  if (!isPlain(input)) {
    throw new TypeError('options.remoteRefs must be an object');
  }
  const types = {
    enabled: ['boolean'], allowList: ['array', 'function'], protocols: ['array'], timeoutMs: ['number'],
    maxBytes: ['number'], maxRedirects: ['number'], maxRefs: ['number'], maxDepth: ['number'],
    allowPrivateHosts: ['array'], resolver: ['function'], schemas: ['object'], integrity: ['object']
  };
  const result = { ...DEFAULT_REMOTE };
  for (const [key, accepted] of Object.entries(types)) {
    if (input[key] !== undefined) {
      expectType(`options.remoteRefs.${key}`, input[key], ...accepted);
      result[key] = input[key];
    }
  }
  return result;
}

/**
 * Returns the type name of a value as used in messages (never the value itself).
 * @param {*} value The value.
 * @returns {string} Type name.
 */
function typeName(value) {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * Reads the value found at a JSON pointer.
 * @param {*} data Root value.
 * @param {string} pointer JSON pointer.
 * @returns {*} The value or undefined.
 */
function valueAt(data, pointer) {
  let current = data;
  for (const part of pointer.split('/').slice(1)) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = current[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return current;
}

/**
 * Converts ajv errors into value-free validation issues.
 * @param {object[]} errors The ajv errors.
 * @param {*} data The validated data.
 * @returns {object[]} Issues with `property`, `schemaPath`, `keyword`, `expected` and `received`.
 */
function toIssues(errors, data) {
  return (errors ?? []).map((e) => {
    let property = e.instancePath;
    let expected = e.keyword === 'type' ? [].concat(e.params.type).join('|') : e.message;
    if (e.keyword === 'required') {
      property = `${property}/${e.params.missingProperty}`;
      expected = 'required property';
    } else if (e.keyword === 'additionalProperties') {
      property = `${property}/${e.params.additionalProperty}`;
      expected = 'no additional properties';
    }
    return {
      property, schemaPath: e.schemaPath, keyword: e.keyword, expected, received: typeName(valueAt(data, property))
    };
  });
}

/**
 * Builds the error message of an issue (no values).
 * @param {object} issue The issue.
 * @returns {string} Message.
 */
function issueMessage(issue) {
  return `Property '${issue.property || '/'}' failed '${issue.keyword}' at '${issue.schemaPath}': ` +
    `expected ${issue.expected}, received ${issue.received}`;
}

/**
 * Creates an error of a class from the validation issues.
 * @param {Function} ErrorClass Error class.
 * @param {string} code Error code.
 * @param {object[]} issues Issues (not empty).
 * @param {*} data Validated data.
 * @returns {ValidInstanceError} The error.
 */
function issueError(ErrorClass, code, issues, data) {
  const first = issues[0];
  return new ErrorClass(issueMessage(first), {
    code, property: first.property, schemaPath: first.schemaPath, expected: first.expected,
    received: first.received, value: valueAt(data, first.property), issues
  });
}

/**
 * Selects the ajv class matching the `$schema` of a schema.
 * @param {*} schema The schema.
 * @returns {Function} Ajv class.
 */
function pickAjv(schema) {
  const declared = schema && typeof schema === 'object' ? schema.$schema : undefined;
  if (declared === undefined || /2020-12/.test(String(declared))) {
    return Ajv2020;
  }
  if (/draft-07/.test(String(declared))) {
    return Ajv07;
  }
  throw new InvalidJsonSchemaError(`Unsupported $schema '${declared}'`, { code: 'SCHEMA_INVALID' });
}

/**
 * Turns the `schema` argument into a parsed schema.
 * @param {*} input Object, JSON text or URL.
 * @param {object} loader Schema loader.
 * @returns {Promise<{schema: *, remote: boolean, base: string|undefined}>} The schema and where it came from.
 */
async function resolveRoot(input, loader) {
  if (isPlain(input)) {
    return { schema: dedupeSchema(input), remote: false, base: undefined };
  }
  if (!check(input).is('string')) {
    throw new TypeError('schema must be an object, a JSON string or a URL string');
  }
  const text = input.trim();
  if (text.startsWith('{')) {
    try {
      return { schema: dedupeSchema(JSON.parse(text)), remote: false, base: undefined };
    } catch (cause) {
      throw new InvalidJsonSchemaError('Schema text is not valid JSON', { code: 'SCHEMA_PARSE', cause });
    }
  }
  if (!/^https?:\/\//i.test(text)) {
    throw new InvalidJsonSchemaError('Schema string is neither JSON text nor an http(s) URL', { code: 'SCHEMA_PARSE' });
  }
  return { schema: await loader.load(text), remote: true, base: new URL(text).href };
}

/**
 * Compiles the schema with ajv, resolving `$ref`s through the loader.
 * @param {object} root Result of {@link resolveRoot}.
 * @param {object} loader Schema loader.
 * @returns {Promise<Function>} The ajv validate function.
 */
async function compile(root, loader) {
  const { schema } = root;
  const Ajv = pickAjv(schema);
  const ajv = new Ajv({ strict: true, loadSchema: (uri) => loader.load(uri) });
  addFormats(ajv);
  if (schema && typeof schema === 'object') {
    if (RESERVED.some((name) => schema.properties && Object.hasOwn(schema.properties, name))) {
      throw new InvalidJsonSchemaError(`Schemas may not declare the reserved properties ${RESERVED.join(', ')}`, {
        code: 'RESERVED_PROPERTY'
      });
    }
    loader.noteRefs(schema, root.base ?? schema.$id ?? 'urn:valid-instance:root', 0);
  }
  try {
    return await ajv.compileAsync(schema);
  } catch (error) {
    if (error instanceof ValidInstanceError) {
      throw error;
    }
    throw new InvalidJsonSchemaError(`Schema could not be compiled: ${error.message}`, {
      code: 'SCHEMA_INVALID', cause: error
    });
  }
}

/**
 * Captures the state of a property so a mutation can be undone.
 * @param {object} target Object being mutated.
 * @param {string|symbol} prop Property key.
 * @returns {() => void} Restore function.
 */
function snapshot(target, prop) {
  const descriptor = Object.getOwnPropertyDescriptor(target, prop);
  const length = Array.isArray(target) ? target.length : undefined;
  return () => {
    if (descriptor) {
      Object.defineProperty(target, prop, descriptor);
    } else {
      delete target[prop];
    }
    if (length !== undefined && prop !== 'length') {
      target.length = length;
    }
  };
}

/**
 * Creates a typed object: a Proxy whose own enumerable properties are validated against a JSON Schema.
 * @param {object|string} schema A schema object, JSON schema text, or an http(s) URL of a schema.
 * @param {object} [initial] Initial values.
 * @param {object} [options] Options, see the README.
 * @returns {Promise<object>} The typed object.
 * @throws {TypeError} When a parameter has the wrong type.
 * @throws {InvalidJsonSchemaError} When the schema is invalid or breaks policy.
 * @throws {JsonSchemaCommError} When a remote schema cannot be fetched.
 * @throws {InitializationError} When `initial` fails validation.
 */
export async function validInstance(schema, initial, options) {
  const opts = normalizeOptions(options);
  if (initial !== undefined && !isPlain(initial)) {
    throw new TypeError('initial must be an object');
  }
  try {
    return await build(schema, initial, opts);
  } catch (error) {
    if (error instanceof ValidInstanceError && !error.logged) {
      error.logged = true;
      logAndReturn(error, opts.logErrorToConsole);
    }
    throw error;
  }
}

/**
 * Builds the typed object once the options are known to be valid.
 * @param {*} schema Schema argument.
 * @param {object} initial Initial data.
 * @param {object} opts Normalized options.
 * @returns {Promise<object>} The typed object.
 */
async function build(schema, initial, opts) {
  seedCache(opts.remoteRefs.schemas);
  const loader = createLoader(opts.remoteRefs, false);
  const root = await resolveRoot(schema, loader);
  const fileLoader = root.remote ? loader : createLoader(opts.remoteRefs, true);
  const validateFn = await compile(root, fileLoader);
  const ctx = { opts, validateFn, data: {} };
  if (initial !== undefined) {
    ctx.data = structuredClone(initial);
    if (opts.validateOnInit) {
      const result = runValidation(ctx);
      if (!result.valid) {
        throw issueError(InitializationError, 'INIT_INVALID', result.errors, ctx.data);
      }
    }
  }
  return createProxy(ctx);
}

/**
 * Validates the current data.
 * @param {object} ctx Instance context.
 * @returns {{valid: boolean, errors?: object[]}} The result.
 */
function runValidation(ctx) {
  if (ctx.validateFn(ctx.data)) {
    return { valid: true };
  }
  return { valid: false, errors: toIssues(ctx.validateFn.errors, ctx.data) };
}

/**
 * Validates after a mutation; reverts and throws, or warns, on failure.
 * @param {object} ctx Instance context.
 * @param {() => void} revert Undoes the mutation.
 * @returns {void}
 */
function checkMutation(ctx, revert) {
  const result = runValidation(ctx);
  if (result.valid) {
    return;
  }
  const error = issueError(InvalidValueError, 'VALUE_INVALID', result.errors, ctx.data);
  if (ctx.opts.onlyWarn) {
    console.warn(`valid-instance: ${error.message}`);
    return;
  }
  revert();
  throw logAndReturn(error, ctx.opts.logErrorToConsole);
}

/**
 * Creates the `replaceWith()` method.
 * @param {object} ctx Instance context.
 * @returns {Function} The method.
 */
function makeReplaceWith(ctx) {
  const clear = () => {
    for (const key of Reflect.ownKeys(ctx.data)) {
      delete ctx.data[key];
    }
  };
  return function replaceWith(obj, validateNow = ctx.opts.validateOnInit) {
    if (!isPlain(obj)) {
      throw new TypeError('obj must be an object');
    }
    expectType('validateNow', validateNow, 'boolean');
    clear();
    Object.assign(ctx.data, structuredClone(obj));
    if (!validateNow) {
      return;
    }
    const result = runValidation(ctx);
    if (!result.valid) {
      const error = issueError(InitializationError, 'INIT_INVALID', result.errors, ctx.data);
      clear();
      throw logAndReturn(error, ctx.opts.logErrorToConsole);
    }
  };
}

/**
 * Creates the Proxy for a typed object.
 * @param {object} ctx Instance context.
 * @returns {object} The Proxy.
 */
function createProxy(ctx) {
  const methods = {
    validate: () => runValidation(ctx),
    replaceWith: makeReplaceWith(ctx)
  };
  const proxies = new WeakMap();
  const live = ctx.opts.liveValidate;

  const wrap = (value) => {
    if (!live || value === null || typeof value !== 'object') {
      return value;
    }
    if (!proxies.has(value)) {
      proxies.set(value, new Proxy(value, handler));
    }
    return proxies.get(value);
  };

  const handler = {
    get(target, prop) {
      if (target === ctx.data && Object.hasOwn(methods, prop)) {
        return methods[prop];
      }
      if (typeof prop === 'symbol' || prop in target || prop in Object.prototype) {
        return wrap(Reflect.get(target, prop));
      }
      return null;
    }
  };
  if (live) {
    Object.assign(handler, liveTraps(ctx));
  }
  return new Proxy(ctx.data, handler);
}

/**
 * Creates the mutation traps used when `liveValidate` is true.
 * @param {object} ctx Instance context.
 * @returns {object} Proxy traps.
 */
function liveTraps(ctx) {
  return {
    set(target, prop, value) {
      const revert = snapshot(target, prop);
      Reflect.set(target, prop, value);
      checkMutation(ctx, revert);
      return true;
    },
    deleteProperty(target, prop) {
      const revert = snapshot(target, prop);
      Reflect.deleteProperty(target, prop);
      checkMutation(ctx, revert);
      return true;
    },
    defineProperty(target, prop, descriptor) {
      const revert = snapshot(target, prop);
      const done = Reflect.defineProperty(target, prop, descriptor);
      if (done) {
        checkMutation(ctx, revert);
      }
      return done;
    }
  };
}
