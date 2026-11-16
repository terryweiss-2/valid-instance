# valid-instance

Typed objects: objects whose properties are validated against a JSON Schema. See [`SPEC.md`](SPEC.md) for the full
specification.

```js
import { validInstance } from 'valid-instance';

const person = await validInstance({
  type: 'object',
  properties: { age: { type: 'integer' } },
  required: ['age']
}, { age: 42 }, { liveValidate: true });

person.validate();   // { valid: true }
person.age = 'x';    // throws InvalidValueError; person.age is still 42
person.replaceWith({ age: 7 });
```

Requires Node.js >= 18 (ESM). Dependencies: `ajv`, `ajv-formats`, `check-type`; tests use `tap`.

## API

### `validInstance(schema, initial?, options?)` → `Promise<TypedObject>`

- `schema`: a schema object, JSON schema text (starts with `{`), or an `http(s)` URL of a schema.
- `initial`: optional plain object. Validated when `validateOnInit` is true. It is cloned.
- The result is a `Proxy`. Missing properties read as `null`. `default` keywords are not applied.
- `validate()` returns `{ valid: true }` or `{ valid: false, errors: ValidationIssue[] }` and never throws. An issue is
  `{ property, schemaPath, keyword, expected, received }` (no values).
- `replaceWith(obj, validateNow = validateOnInit)` replaces the content in place. If validation fails the object is
  left empty and `InitializationError` is thrown.
- `validate` and `replaceWith` are reserved; a schema declaring them as root properties throws
  `InvalidJsonSchemaError` (`RESERVED_PROPERTY`).

### `clearSchemaCache()`

Empties the process-wide schema cache (mainly for tests).

### Options

| Option                         | Default      | Description                                                                              |
|--------------------------------|--------------|------------------------------------------------------------------------------------------|
| `validateOnInit`               | `true`       | Validate `initial`; failure throws `InitializationError`.                                |
| `liveValidate`                 | `false`      | Validate every mutation (deep). A rejected mutation is rolled back.                      |
| `onlyWarn`                     | `false`      | With `liveValidate`: accept invalid mutations and `console.warn()` instead of throwing.  |
| `logErrorToConsole`            | `true`       | `console.error()` when throwing. Values are never logged.                                |
| `remoteRefs.enabled`           | `false`      | Allow network fetches. Pre-seeded schemas always resolve.                                |
| `remoteRefs.allowList`         | `[]`         | Exact hostnames (or `host:port`), or a `(URL) => boolean`. Empty fails closed.           |
| `remoteRefs.protocols`         | `['https:']` | Allowed protocols.                                                                       |
| `remoteRefs.timeoutMs`         | `5000`       | Timeout per fetch (including redirects).                                                 |
| `remoteRefs.maxBytes`          | `1048576`    | Maximum response size.                                                                   |
| `remoteRefs.maxRedirects`      | `0`          | Redirects followed; every hop is re-validated.                                           |
| `remoteRefs.maxRefs`           | `50`         | Maximum distinct remote schemas per call.                                                |
| `remoteRefs.maxDepth`          | `10`         | Maximum `$ref` chain depth.                                                              |
| `remoteRefs.allowPrivateHosts` | `[]`         | Hosts/IPs allowed to resolve to loopback/private ranges.                                 |
| `remoteRefs.resolver`          | none         | `async (uri) => schema` replacing the network fetch.                                     |
| `remoteRefs.schemas`           | `{}`         | Pre-seeded schemas by URI.                                                               |
| `remoteRefs.integrity`         | `{}`         | Expected sha256 (hex) of the schema text per URI.                                        |

### Errors

All extend `ValidInstanceError` (fields `code`, `property`, `schemaPath`, `expected`, `received`, `value`, `cause`):
`InitializationError`, `InvalidValueError`, `InvalidJsonSchemaError`, `JsonSchemaCommError`. Remote fetches are
protected against SSRF: IPs are checked after DNS resolution and the connection is pinned to the checked address.

## Tests

```
npm test
```
