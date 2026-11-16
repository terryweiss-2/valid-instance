# Typed Object

A typed object is an object that validates its properties against a JSON Schema. It is created by the factory
`validInstance()`.

## Overview

- The library exports one factory, `validInstance(schema, initial?, options?)`, which returns a `Promise` of a typed
  object.
- The typed object is a `Proxy` whose own enumerable properties match the schema.
- The factory is **async**: `await validInstance(schema, initial, options)`. Schemas (and their `$ref`s) are resolved
  before the typed object is returned.
- Supported JSON Schema drafts are those supported by `ajv` (draft-07 and 2020-12). The draft is chosen from `$schema`;
  when `$schema` is absent, 2020-12 is used. An unsupported `$schema` raises `InvalidJsonSchemaError`.
- Ajv is created with `strict: true`.

### Non-goals

- The library does not mutate the supplied schema.
- No custom formats beyond those provided by `ajv` / `ajv-formats`.
- Sparse objects are not supported.

## Options

| Option                      | Type                           | Default               | Description                                                                                                                  |
|-----------------------------|--------------------------------|-----------------------|------------------------------------------------------------------------------------------------------------------------------|
| `validateOnInit`            | boolean                        | `true`                | Validate `initial` against the schema. On failure throw `InitializationError`, regardless of `onlyWarn`.                      |
| `liveValidate`              | boolean                        | `false`               | Validate on every mutation (set, delete, defineProperty).                                                                    |
| `onlyWarn`                  | boolean                        | `false`               | Only applies when `liveValidate` is true. When true, invalid mutations are accepted and a `console.warn()` is written.        |
| `logErrorToConsole`         | boolean                        | `true`                | Log errors with `console.error()` when throwing. Never logged when the failure is downgraded to a warning (no double-log).    |
| `remoteRefs.enabled`        | boolean                        | `false`               | Allow fetching remote `$ref`s and URL schemas from the network. When false, only pre-seeded/cached schemas resolve.          |
| `remoteRefs.allowList`      | `string[]` \| `(url) => bool`  | `[]`                  | Approved hosts. Hostnames match exactly (case-insensitive, no wildcards); a port is part of the match only if specified. Empty list with `enabled: true` fails closed (nothing is fetched). |
| `remoteRefs.protocols`      | `string[]`                     | `['https:']`          | Allowed URL schemes.                                                                                                         |
| `remoteRefs.timeoutMs`      | number                         | `5000`                | Per-request timeout, including redirects.                                                                                    |
| `remoteRefs.maxBytes`       | number                         | `1048576` (1 MiB)     | Maximum response size.                                                                                                       |
| `remoteRefs.maxRedirects`   | number                         | `0`                   | Redirects followed; each hop is fully re-validated (protocol, allow list, IP).                                               |
| `remoteRefs.maxRefs`        | number                         | `50`                  | Maximum number of distinct remote schemas fetched per factory call.                                                          |
| `remoteRefs.maxDepth`       | number                         | `10`                  | Maximum `$ref` chain depth.                                                                                                  |
| `remoteRefs.allowPrivateHosts` | `string[]`                  | `[]`                  | Hostnames/IPs explicitly allowed to resolve to loopback/private/link-local ranges (e.g. local test servers).                  |
| `remoteRefs.resolver`       | `(uri) => Promise<schema>`     | none                  | Custom async resolver replacing network fetching (own cache, private registry, signed bundle). Results still pass schema validation rules. |
| `remoteRefs.schemas`        | `{ [uri: string]: object }`    | `{}`                  | Pre-seed the cache. Pre-seeded entries take priority over the network, even when `enabled` is false.                          |
| `remoteRefs.integrity`      | `{ [uri: string]: string }`    | `{}`                  | Expected `sha256` (hex) of the schema text per URI; mismatch raises `JsonSchemaCommError` with code `INTEGRITY_MISMATCH`.     |

Invalid option values (wrong type) throw `TypeError`; public parameters are checked with `check-type` unless covered by
a JSON Schema.

## API

| Symbol                                          | Signature                                                              |
|-------------------------------------------------|------------------------------------------------------------------------|
| `validInstance(schema, initial?, options?)`     | `Promise<TypedObject>`                                                 |
| `typedObject.validate()`                        | `{ valid: true } \| { valid: false, errors: ValidationIssue[] }`       |
| `typedObject.replaceWith(obj, validateNow?)`    | `void` (throws `InitializationError`)                                  |
| `clearSchemaCache()`                            | `void` (primarily for tests)                                           |

A `ValidationIssue` is `{ property, schemaPath, keyword, expected, received }` (no values).

### Factory

- `schema` is required and is one of: an object, a string containing JSON Schema text (if it starts with `{` after
  trimming), or a URL string (`http:`/`https:`). URL schemas require `remoteRefs.enabled` or a cached/pre-seeded entry.
- `initial` is optional. When omitted, the object starts empty and is not validated; `validate()` can be called later.
- `default` keywords are **not** applied. Missing properties read as `null`; this library does not contemplate sparse
  objects.
- Rejected mutations leave the previous value in place.

### Reserved methods

`validate` and `replaceWith` are exposed as non-enumerable members of the Proxy, so they do not appear in
`Object.keys()` or validation. If a schema declares a property named `validate` or `replaceWith`, the factory throws
`InvalidJsonSchemaError` (code `RESERVED_PROPERTY`).

### Live validation

- Requires `Proxy` traps for `set`, `deleteProperty` and `defineProperty`. The candidate state is validated before it is
  committed.
- Nested objects and arrays are proxied deeply, so mutations such as `obj.a.b = 1` or `obj.list.push(x)` are validated
  against the root schema.
- With `onlyWarn` false an invalid mutation throws `InvalidValueError` and the old value is kept. With `onlyWarn` true
  the mutation is applied and a warning is logged.

### `validate()`

Validates the current state and never throws. Returns `{ valid: true }` or `{ valid: false, errors }`.

### `replaceWith(obj, validateNow = validateOnInit)`

- Replaces the whole stored object **in place**: identity of the Proxy is preserved, old keys are deleted. This lets one
  container process a stream of records.
- If `validateNow` is true and validation fails, the Proxy is left **empty** (every `get` returns `null`) so that no
  stale or invalid record is visible, and `InitializationError` is thrown.

## Caching schemas

- Resolved schemas are cached in memory, process-wide (shared among all factory instances). `clearSchemaCache()` empties
  it (for tests).
- Key: for URLs, the normalized URL without fragment; for string schemas, the `sha256` of the text; for object schemas,
  the `sha256` of the stable-stringified object.
- A URL found in the cache is reused with no network access. Identical schemas are deduplicated.
- In-flight fetches for the same URI are deduplicated (one request, shared promise). Failed fetches are not cached.
- No TTL: entries live for the process lifetime.
- Every remote fetch is logged with `console.warn()`; cache hits are not.

## Remote refs and security

Protect against DoS, SSRF, schema poisoning and other attacks on the validation process.

### Network rules

- URLs must use an allowed protocol (default `https:`), must not contain credentials (`user:pass@`), and the host must
  pass the allow list. `file:` and `data:` are never fetched.
- Resolve DNS first, check every returned IP, then **pin** the connection to the validated IP (prevents DNS rebinding).
  Re-check on every redirect.
- Block: `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (cloud
  metadata), `0.0.0.0`, `::1`, `fc00::/7`, `fe80::/10` and IPv4-mapped IPv6 addresses of those ranges. Only
  `allowPrivateHosts` can override this.
- Send no cookies or authorization headers. Use the fixed header `User-Agent: valid-instance/<version>`.
- Enforce `timeoutMs`, `maxBytes`, `maxRedirects`, `maxRefs` and `maxDepth`.

### Content rules

- Do not trust `content-type`: the body must parse as JSON and be structurally a schema (an object or boolean) and
  compile in `ajv`; otherwise `InvalidJsonSchemaError`.
- A schema fetched from a URL must not contain `$ref`s to `file:` or `data:`, and must not claim an `$id` on another
  host than the one it was fetched from. If the schema was provided as an object or string, `file:` refs are allowed.
- If `remoteRefs.integrity` has an entry for the URI, the `sha256` must match.
- `pattern` regexes are a ReDoS risk; schemas from remote sources are compiled with `ajv` `strict: true` and
  consumers should pre-seed vetted schemas for untrusted domains.

## Warnings

Warnings use `console.warn()`: live-validation failures when `onlyWarn` is true, and remote fetches.

## Errors

All errors extend `ValidInstanceError`, which extends `Error`, with fields: `name`, `code`, `message`, `property`
(JSON pointer path), `schemaPath`, `expected`, `received` (type only), `value` (attached to the error object, never in
`message` or logs) and `cause`.

Message format: `Property '/age' failed 'type' at '#/properties/age/type': expected integer, received string`.

| Class                     | Thrown when                                                                  | Example `code`                                                |
|---------------------------|------------------------------------------------------------------------------|---------------------------------------------------------------|
| `InitializationError`     | `initial` or `replaceWith()` data fails validation.                          | `INIT_INVALID`                                                |
| `InvalidValueError`       | A live mutation fails validation and `onlyWarn` is false.                    | `VALUE_INVALID`                                               |
| `InvalidJsonSchemaError`  | A schema can't be parsed, isn't a valid schema, or breaks policy rules.      | `SCHEMA_PARSE`, `SCHEMA_INVALID`, `RESERVED_PROPERTY`         |
| `JsonSchemaCommError`     | A fetch could not happen: network, timeout, size, redirect, protocol, blocked host. | `REMOTE_REF_BLOCKED` (policy), `TIMEOUT`, `TOO_LARGE`, `NETWORK`, `INTEGRITY_MISMATCH` |

## Logging

- `console.error()` is used when `logErrorToConsole` is true and an error is thrown. It is not used when the failure is
  downgraded to a warning by `onlyWarn`.
- Logs never contain property values. Logged URLs have credentials and query strings stripped.

## Implementation notes

- Use `ajv` (with `ajv-formats`) and its `loadSchema` hook, backed by a guarded fetcher (`node:dns` lookup, IP check,
  pinned connection).
- Runtime: Node.js >= 18, ESM. Dependencies: `ajv`, `ajv-formats`, `check-type`; dev: `tapjs`. Ask for approval before
  adding any other npm package.
- The factory lives in `valid-instance.js` and is re-exported from `index.js`. Other files may be created to control
  complexity.
- Provide `index.d.ts` TypeScript definitions for all public APIs.
- Add JSDoc to all public symbols; follow the linting rules in `LINTER.md`.
- Type-check public parameters with `check-type`.
- Document the API in `README.md` and update it with every signature or behavior change.

## Testing

Use `tapjs`. Tests must confirm the factory matches this spec, including:

- Each option default, and each error class/code and message format.
- `validate()` result shape, `replaceWith()` in-place semantics and empty-on-failure behavior.
- Live validation: set/delete/nested mutation, rejected set keeps old value, `onlyWarn` warns once and does not log an
  error.
- Schemas split across multiple files (local `$ref`s).
- One open-source schema with `$ref`s (e.g. a SchemaStore schema) loaded from its remote location, plus offline tests
  using a local HTTP server (with `allowPrivateHosts`) for: allow list, blocked IPs, DNS rebinding/pinning, redirect
  re-validation, timeout, `maxBytes`, non-JSON body, foreign `$id`, `file:` refs, integrity mismatch, in-flight dedupe,
  and cache reuse.
- Offline operation with a pre-seeded cache and `enabled: false`.

## Examples

```js
import { validInstance } from 'valid-instance'

// Basic
const person = await validInstance({
  type: 'object',
  properties: { age: { type: 'integer' } },
  required: ['age']
}, { age: 42 })
person.validate() // { valid: true }

// Live validation
const strict = await validInstance(schema, { age: 1 }, { liveValidate: true })
strict.age = 'x' // throws InvalidValueError; strict.age is still 1

// Remote refs with allow list
const remote = await validInstance('https://example.com/schemas/person.json', {}, {
  remoteRefs: { enabled: true, allowList: ['example.com'] }
})

// Offline, pre-seeded cache
const offline = await validInstance(schema, data, {
  remoteRefs: { schemas: { 'https://example.com/defs.json': defs } }
})
```

## Open decisions

- Confirm the factory is async (breaking for sync consumers); a `validInstanceSync` could be added for fully pre-seeded
  schemas.
- Confirm `validate()` returns a result object rather than an error instance or `null`.
- Confirm reserved method names (`validate`, `replaceWith`) as non-enumerable members vs Symbols.
- Confirm `strict: true` in `ajv` is acceptable for all consumer schemas.
