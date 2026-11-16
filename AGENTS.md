Guidance for agents working in this repository.

- Prefer available libraries over new code. Ask for approval before adding any new npm dependency.
- Linting rules are defined in [`LINTER.md`]

## Layout

- `index.js` Main entry point for the library.
- `README.md` Documentation for the library. The API docs and overview are maintained here.

## Testing

- use `tapjs` for testing
- Test with schemas contained in multiple files.
- Find one open source JSON Schema with `ref`s and make sure they can be followed and loaded from remote locations

## Agent file locations

- Store all skills in `.agents/skills`.
- Store all plans in `.agents/plans`.
- Do **NOT** store plans in `.junie/plans`.

## Behaviors

- Always type check parameters with `check-type` for any public API, unless it is covered by a JSON Schema.
- Prefer GNU Make for shell scripts and build automation.
- Always add jsdoc module level documentation for all public symbols in the library
- Create and maintain TypeScript definitions for all public APIs.
- Any updates to the API signature or behaviors need to be updated in the `README.md`.

## Dependencies

- `ajv`
- `tapjs`

