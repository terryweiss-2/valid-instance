---
sessionId: session-261116-133854-squt
---

# Requirements

### Overview & Goals
Improve `SPEC.md` for the typed-object factory `validInstance()` so it is unambiguous, internally consistent, secure, and implementable and testable as written. This plan covers spec improvements only. Code is out of scope for now.

### Suggested Improvements
**1. Fix typos and naming inconsistencies**
- `InvalidJsonSchemError` -> `InvalidJsonSchemaError`; `JsonSchemCommError` -> `JsonSchemaCommError`; `shema`, `teh`, and `` `validateNow** `` (broken markdown) need fixing.
- The spec cites `LINT.md`, but the file is `LINTER.md`.
- File name `valid.instance.js` vs factory `validInstance()`. Pick one convention (e.g. `valid-instance.js`) and say that `index.js` re-exports it.
- Wording: 'Inherit all error from Error' -> 'All errors extend Error'.

**2. Resolve behavioral ambiguities**
- `onlyWarn` has no default. State `false`. Say whether it only matters when `liveValidate` is true. Today `onlyWarn` is also described as 'accept any value', so define its interaction with `validateOnInit` (init failure always throws, as the spec already says).
- `liveValidate`: clarify that this needs a `Proxy` (set trap, and deleteProperty/defineProperty). Decide whether nested objects/arrays are proxied deeply. Decide whether a rejected set leaves the old value in place (it should).
- 'Same schema as the json schema' is unclear. Rephrase it to: the returned object is a Proxy whose own enumerable properties match the schema. Define defaults handling (apply `default`? no by default).
- `validate()` returns `InvalidValue`, but no such type is defined. Define the return contract: `{ valid: true } | { valid: false, errors: ValidationIssue[] }`, or return an `InvalidValueError` instance (not thrown). Pick one.
- `replaceWith(obj, validateNow)`: state the default for `validateNow` (same as `validateOnInit`), whether it replaces in place (keeps identity, deleting old keys), and the behavior on failure (the previous state is retained and `InitializationError` or `InvalidValueError` is thrown).
- Also need a way to name the reserved methods without colliding with schema properties (`validate`, `replaceWith`). Options: non-enumerable members, or Symbols/a `$` prefix. Document the collision rule.
- Define when the schema is resolved: the factory must be async (it returns a Promise) if remote refs are enabled. State this explicitly. Provide `validInstanceSync` or error if refs are unresolved.
- Schema input forms: object, URL string, or both. Define which.
- JSON Schema draft: specify the supported drafts (ajv default 2020-12/draft-07) and `$schema` handling.

**3. Remote ref and security details**
- `remoteRefs` defaults: `protocols: ['https:']`, `timeoutMs: 5000`, `maxBytes: 1 MiB`, `maxRedirects: 0` or re-validated per hop, `maxDepth`/`maxRefs` limits to stop ref-chain fan-out.
- SSRF: validate IP **after DNS resolution** and pin the connection to the validated IP (prevents DNS rebinding). Re-check on every redirect. Block `localhost`, `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (cloud metadata), `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6, and `0.0.0.0`. Add `allowPrivateHosts` option for explicit allow-listing.
- `allowList` hostname semantics: exact match vs wildcard; port handling; empty list + `enabled: true` = fail closed.
- Disallow credentials in URLs; do not send cookies or auth headers; set a fixed User-Agent.
- Schema poisoning: forbid `$ref` to `file:`/`data:`; pin `$id` rules (a fetched schema must not claim another host's `$id`); optional `integrity` map (URI -> sha256) for pre-seeded or verified schemas; limit regex complexity (ReDoS in `pattern`). Ajv option `strict: true`.
- Cache: define key (normalized URI w/o fragment), no TTL (process lifetime) or optional TTL, an API to pre-seed (`remoteRefs.cache` / `schemas: {uri: schema}`), and whether it is shared across factory calls (spec says process-wide; state exposure of `clearSchemaCache()` for tests). Pre-seeded entries take priority over network, even when `enabled` is false.
- Concurrency: deduplicate in-flight fetches for the same URI.

**4. Errors and logging**
- Define a common base `ValidInstanceError` that extends `Error`, with fields: `name`, `code`, `property` (path), `schemaPath`, `expected`, `received` (type only), `value` (attached to the error object, never in `message`), and `cause`.
- Message format example: `Property '/age' failed 'type' at '#/properties/age/type': expected integer, received string`.
- Clarify who throws which error: `InitializationError` (init/`replaceWith` fail), `InvalidValueError` (live set fail), `InvalidJsonSchemaError` (parse/shape failure), `JsonSchemaCommError` (network, timeout, size, blocked host, protocol). Distinguish a blocked (policy) failure with a `code` like `REMOTE_REF_BLOCKED`.
- Console: `console.error` when `logErrorToConsole`, `console.warn` for warnings and remote fetches. The log must not contain values. Include a fetched URL but strip query strings and credentials.
- `logErrorToConsole` is required to not double-log with `onlyWarn`.

**5. Missing sections to add**
- Options table with type, default, and description for all options.
- Public API table with signatures and a TypeScript definitions file (`index.d.ts`), as `AGENTS.md` requires.
- Examples (basic, live validate, remote refs with allow list, offline pre-seeded cache).
- Out of scope / non-goals (no mutation of the schema, no custom formats beyond ajv).
- Runtime support (Node >= 18 for global `fetch`, ESM vs CJS) and the dependency list (`ajv`, `ajv-formats`, `check-type`, `tapjs`; ask approval before adding new npm packages).
- Acceptance criteria and testing requirements per `AGENTS.md`: tests with multi-file schemas, and an open-source schema with `$ref`s loaded remotely (e.g. a SchemaStore schema) plus offline tests using a local HTTP server.
- Per `AGENTS.md`: README updates, JSDoc on all public symbols, `check-type` on public params.

### Out of Scope
Implementing the library.

### Non-Functional Requirements
Spec must be testable: each behavior has an observable outcome.

# Technical Design

### Current Implementation
The repo contains only `SPEC.md`, `AGENTS.md`, `LINTER.md` and `LICENSE`. There is no code, `package.json`, or tests.

### Proposed Changes
- Edit `SPEC.md` in place. Restructure it into: Overview, Options (table), API (factory, `validate()`, `replaceWith()`), Remote refs, Caching, Security, Errors, Logging, Implementation notes, Testing, Examples.
- Keep the existing requirements, but fix the wording and fill in the gaps listed in Requirements.
- Add a short 'Open decisions' list at the end for items needing owner confirmation (sync vs async factory, `validate()` return type, reserved method names).

### Key Decisions (proposed defaults)
- Factory is async: `await validInstance(schema, initial, options)`.
- `validate()` returns a result object and never throws.
- Resolution via `ajv` with `loadSchema` hook backed by a guarded fetcher (`node:dns` lookup + IP check + pinned connection).
- Errors extend a common `ValidInstanceError` base.

### Risks
- DNS-rebinding and redirect SSRF if the IP is checked only before the connection. Mitigate by pinning.
- Proxy-based live validation does not catch mutation of nested objects unless deep-proxied. Document it.
- Async factory is a breaking decision for consumers. Confirm early.

# Delivery Steps

### ✓ Step 1: Fix typos and naming inconsistencies in SPEC.md
SPEC.md has consistent names and valid markdown.

- Rename `InvalidJsonSchemError` and `JsonSchemCommError` to `InvalidJsonSchemaError` and `JsonSchemaCommError`.
- Fix `LINT.md` -> `LINTER.md`, the broken `validateNow` markup, and other typos.
- Decide and state the file naming for `valid-instance.js` and `index.js` re-export.
- Add `onlyWarn` default and fix 'Inherit all error' wording.

### ✓ Step 2: Define API contracts, options table and error model
SPEC.md fully specifies the public API and errors.

- Add an options table (type, default, description) for all options.
- Specify the async factory, schema input forms, `validate()` return shape, and `replaceWith()` semantics (in place, default of `validateNow`, failure behavior).
- Define the reserved method name collision rule and Proxy/nested semantics for `liveValidate`.
- Define the `ValidInstanceError` base, fields, message format, error codes, and logging rules (never log values).

### ✓ Step 3: Harden remote ref, caching and security sections
SPEC.md has concrete, testable security and cache requirements.

- Specify defaults for `protocols`, `timeoutMs`, `maxBytes`, redirects, and ref depth/count limits.
- Add SSRF rules: post-DNS IP check, IP pinning, redirect re-validation, blocked ranges, and the private-host allow-list option.
- Add schema validation rules (JSON parse, schema shape, `$id` and `$ref` scheme restrictions, optional integrity hashes).
- Define cache key, pre-seeding, in-flight dedupe, process-wide scope, and a test-only clear function.

### ✓ Step 4: Add examples, testing and delivery requirements to SPEC.md
SPEC.md ends with examples, acceptance criteria and an open-decisions list.

- Add usage examples (basic, live validation, remote refs with allow list, offline cache).
- Add testing requirements: `tapjs`, multi-file schemas, an open-source remote-ref schema, local HTTP server tests for the security cases.
- Add runtime, dependency, README, JSDoc, `check-type` and `index.d.ts` requirements from AGENTS.md.
- List open decisions for the owner to confirm.