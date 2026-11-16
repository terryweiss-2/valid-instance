import t from 'tap';
import { validInstance, InitializationError, InvalidValueError, InvalidJsonSchemaError, ValidInstanceError } from '../index.js';

const schema = {
  type: 'object',
  properties: { age: { type: 'integer' }, list: { type: 'array', items: { type: 'string' } } },
  required: ['age']
};

t.test('basic validation and defaults', async (t) => {
  const p = await validInstance(schema, { age: 42 });
  t.same(p.validate(), { valid: true });
  t.equal(p.missing, null, 'missing properties read as null');
  t.same(Object.keys(p), ['age'], 'methods are not enumerable');
  p.age = 'x';
  const res = p.validate();
  t.equal(res.valid, false, 'non-live mutation is accepted but validate() reports');
  t.match(res.errors[0], { property: '/age', keyword: 'type', expected: 'integer', received: 'string' });
});

t.test('initial validation', async (t) => {
  const quiet = t.capture(console, 'error');
  await t.rejects(validInstance(schema, { age: 'x' }), {
    name: 'InitializationError', code: 'INIT_INVALID',
    message: "Property '/age' failed 'type' at '#/properties/age/type': expected integer, received string"
  });
  t.equal(quiet.args().length, 1, 'logged once');
  t.notMatch(String(quiet.args()[0]), /"x"/, 'value not logged');
  const err = await validInstance(schema, { age: 'secret' }, { logErrorToConsole: false }).catch((e) => e);
  t.ok(err instanceof ValidInstanceError && err instanceof InitializationError && err instanceof Error);
  t.equal(err.value, 'secret');
  t.notMatch(err.message, /secret/);
  const ok = await validInstance(schema, { age: 'x' }, { validateOnInit: false });
  t.equal(ok.age, 'x');
});

t.test('live validation', async (t) => {
  const p = await validInstance(schema, { age: 1, list: [] }, { liveValidate: true, logErrorToConsole: false });
  t.throws(() => { p.age = 'x'; }, InvalidValueError);
  t.equal(p.age, 1, 'old value kept');
  t.throws(() => { p.list.push(5); }, InvalidValueError);
  t.equal(p.list.length, 0);
  p.list.push('a');
  t.equal(p.list[0], 'a');
  t.throws(() => { delete p.age; }, InvalidValueError);
  t.equal(p.age, 1);
});

t.test('onlyWarn', async (t) => {
  const warn = t.capture(console, 'warn');
  const error = t.capture(console, 'error');
  const p = await validInstance(schema, { age: 1 }, { liveValidate: true, onlyWarn: true });
  p.age = 'x';
  t.equal(p.age, 'x');
  t.equal(warn.args().length, 1);
  t.equal(error.args().length, 0);
});

t.test('replaceWith', async (t) => {
  const p = await validInstance(schema, { age: 1 }, { logErrorToConsole: false });
  p.replaceWith({ age: 2 });
  t.equal(p.age, 2);
  t.throws(() => p.replaceWith({ age: 'x' }), InitializationError);
  t.equal(p.age, null, 'empty after failure');
  t.same(Object.keys(p), []);
  p.replaceWith({ age: 'x' }, false);
  t.equal(p.age, 'x');
});

t.test('schema forms, drafts and errors', async (t) => {
  const text = JSON.stringify(schema);
  t.equal((await validInstance(text, { age: 1 })).age, 1);
  const d7 = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' };
  t.ok(await validInstance(d7, {}));
  await t.rejects(validInstance({ $schema: 'http://example.com/nope' }), InvalidJsonSchemaError);
  await t.rejects(validInstance('{bad', {}, { logErrorToConsole: false }), { code: 'SCHEMA_PARSE' });
  await t.rejects(validInstance({ type: 'object', properties: { validate: {} } }, {}, { logErrorToConsole: false }),
    { code: 'RESERVED_PROPERTY' });
  await t.rejects(validInstance(5), TypeError);
  await t.rejects(validInstance(schema, [], {}), TypeError);
  await t.rejects(validInstance(schema, {}, { liveValidate: 'yes' }), TypeError);
  await t.rejects(validInstance({ type: 'bogus' }, {}, { logErrorToConsole: false }), { code: 'SCHEMA_INVALID' });
});
