import t from 'tap';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { validInstance, clearSchemaCache } from '../index.js';
import { isBlockedIp } from '../net.js';

/** Starts a local server serving `routes` (path -> {status, body, headers, delay}). */
async function serve(t, routes) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req);
    const r = routes[req.url.split('?')[0]];
    if (!r) { res.statusCode = 404; res.end(); return; }
    setTimeout(() => {
      res.writeHead(r.status ?? 200, r.headers ?? {});
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    }, r.delay ?? 0);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.teardown(() => { server.closeAllConnections?.(); server.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, hits };
}

const local = (extra = {}) => ({
  logErrorToConsole: false,
  remoteRefs: { enabled: true, protocols: ['http:'], allowList: ['127.0.0.1'], allowPrivateHosts: ['127.0.0.1'], ...extra }
});

t.beforeEach(() => clearSchemaCache());

t.test('blocked ranges', async (t) => {
  for (const ip of ['127.0.0.1', '10.1.1.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fc00::1',
    'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    t.ok(isBlockedIp(ip), ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    t.notOk(isBlockedIp(ip), ip);
  }
});

t.test('fetch from local server, cache reuse, warn, UA', async (t) => {
  const warn = t.capture(console, 'warn');
  const { base, hits } = await serve(t, { '/p.json': { body: { type: 'object', properties: { age: { type: 'integer' } } } } });
  const p = await validInstance(`${base}/p.json?token=secret`, { age: 1 }, local());
  t.same(p.validate(), { valid: true });
  t.match(hits[0].headers['user-agent'], /^valid-instance\//);
  t.notOk(hits[0].headers.cookie);
  t.equal(warn.args().length, 1);
  t.notMatch(String(warn.args()[0]), /secret/, 'query stripped from log');
  await validInstance(`${base}/p.json?token=secret`, { age: 1 }, local());
  t.equal(hits.length, 1, 'second call served from cache');
});

t.test('in-flight dedupe', async (t) => {
  t.capture(console, 'warn');
  const { base, hits } = await serve(t, { '/p.json': { body: { type: 'object' }, delay: 100 } });
  await Promise.all([1, 2, 3].map(() => validInstance(`${base}/p.json`, {}, local())));
  t.equal(hits.length, 1);
});

t.test('policy blocks', async (t) => {
  t.capture(console, 'warn');
  const { base } = await serve(t, { '/p.json': { body: { type: 'object' } } });
  const blocked = { code: 'REMOTE_REF_BLOCKED', name: 'JsonSchemaCommError' };
  await t.rejects(validInstance(`${base}/p.json`, {}, { logErrorToConsole: false }), blocked, 'disabled by default');
  await t.rejects(validInstance(`${base}/p.json`, {}, local({ allowList: [] })), blocked, 'empty allow list fails closed');
  await t.rejects(validInstance(`${base}/p.json`, {}, local({ allowList: ['example.com'] })), blocked, 'not on list');
  await t.rejects(validInstance(`${base}/p.json`, {}, local({ protocols: ['https:'] })), blocked, 'protocol');
  await t.rejects(validInstance(`${base}/p.json`, {}, local({ allowPrivateHosts: [] })), blocked, 'private IP');
  await t.rejects(validInstance(`http://user:pw@127.0.0.1:1/p.json`, {}, local()), blocked, 'credentials');
  await t.rejects(validInstance('file:///etc/passwd', {}, local()), InvalidJsonSchemaErrorLike);
  await t.rejects(validInstance('https://localhost/x.json', {}, { logErrorToConsole: false, remoteRefs: { enabled: true, allowList: ['localhost'] } }), blocked, 'localhost blocked');
});
const InvalidJsonSchemaErrorLike = { name: 'InvalidJsonSchemaError' };

t.test('content rules', async (t) => {
  t.capture(console, 'warn');
  const { base } = await serve(t, {
    '/html': { body: '<html>', headers: { 'content-type': 'application/json' } },
    '/num': { body: '5' },
    '/foreign': { body: { $id: 'https://evil.example/s.json', type: 'object' } },
    '/fileref': { body: { type: 'object', properties: { a: { $ref: 'file:///etc/x.json' } } } },
    '/big': { body: { type: 'object', description: 'x'.repeat(5000) } },
    '/slow': { body: { type: 'object' }, delay: 500 },
    '/redir': { status: 302, headers: { location: '/ok' }, body: '' },
    '/ok': { body: { type: 'object' } }
  });
  await t.rejects(validInstance(`${base}/html`, {}, local()), { code: 'SCHEMA_PARSE' });
  await t.rejects(validInstance(`${base}/num`, {}, local()), { code: 'SCHEMA_INVALID' });
  await t.rejects(validInstance(`${base}/foreign`, {}, local()), { code: 'SCHEMA_INVALID' });
  await t.rejects(validInstance(`${base}/fileref`, {}, local()), { code: 'SCHEMA_INVALID' });
  await t.rejects(validInstance(`${base}/big`, {}, local({ maxBytes: 100 })), { code: 'TOO_LARGE' });
  await t.rejects(validInstance(`${base}/slow`, {}, local({ timeoutMs: 50 })), { code: 'TIMEOUT' });
  await t.rejects(validInstance(`${base}/redir`, {}, local()), { code: 'REDIRECT_LIMIT' });
  await t.rejects(validInstance(`${base}/missing`, {}, local()), { code: 'NETWORK' });
  t.ok(await validInstance(`${base}/redir`, {}, local({ maxRedirects: 1 })), 'redirect followed when allowed');
});

t.test('integrity', async (t) => {
  t.capture(console, 'warn');
  const body = JSON.stringify({ type: 'object' });
  const { base } = await serve(t, { '/p.json': { body } });
  const good = createHash('sha256').update(body).digest('hex');
  await t.rejects(validInstance(`${base}/p.json`, {}, local({ integrity: { [`${base}/p.json`]: 'deadbeef' } })),
    { code: 'INTEGRITY_MISMATCH' });
  t.ok(await validInstance(`${base}/p.json`, {}, local({ integrity: { [`${base}/p.json`]: good } })));
});

t.test('remote $ref chain, maxRefs, maxDepth', async (t) => {
  t.capture(console, 'warn');
  const { base } = await serve(t, {
    '/root.json': { body: { type: 'object', properties: { a: { $ref: 'a.json' } } } },
    '/a.json': { body: { type: 'integer' } },
    '/c1.json': { body: { $ref: 'c2.json' } },
    '/c2.json': { body: { $ref: 'c3.json' } },
    '/c3.json': { body: { type: 'integer' } }
  });
  const p = await validInstance(`${base}/root.json`, { a: 1 }, local());
  t.same(p.validate(), { valid: true });
  await t.rejects(validInstance(`${base}/root.json`, { a: 'x' }, local()), { name: 'InitializationError' });
  clearSchemaCache();
  await t.rejects(validInstance(`${base}/root.json`, {}, local({ maxRefs: 1 })), { code: 'REMOTE_REF_BLOCKED' });
  clearSchemaCache();
  await t.rejects(validInstance({ type: 'object', properties: { x: { $ref: `${base}/c1.json` } } }, {}, local({ maxDepth: 2 })),
    { code: 'REMOTE_REF_BLOCKED' });
});

t.test('offline pre-seeded cache with enabled false', async (t) => {
  const defs = { $id: 'https://example.com/defs.json', type: 'integer' };
  const s = { type: 'object', properties: { n: { $ref: 'https://example.com/defs.json' } } };
  const p = await validInstance(s, { n: 1 }, { remoteRefs: { schemas: { 'https://example.com/defs.json': defs } } });
  t.same(p.validate(), { valid: true });
  clearSchemaCache();
  await t.rejects(validInstance(s, { n: 1 }, { logErrorToConsole: false }), { code: 'REMOTE_REF_BLOCKED' });
});

t.test('resolver replaces network', async (t) => {
  t.capture(console, 'warn');
  const s = { type: 'object', properties: { n: { $ref: 'https://example.com/r.json' } } };
  const p = await validInstance(s, { n: 1 }, {
    remoteRefs: { enabled: true, resolver: async () => ({ type: 'integer' }) }
  });
  t.same(p.validate(), { valid: true });
});

t.test('schema split across multiple files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vi-'));
  await writeFile(join(dir, 'address.json'), JSON.stringify({ type: 'object', properties: { zip: { type: 'string' } }, required: ['zip'] }));
  await writeFile(join(dir, 'person.json'), JSON.stringify({
    $id: pathToFileURL(join(dir, 'person.json')).href, type: 'object',
    properties: { name: { type: 'string' }, home: { $ref: 'address.json' } }
  }));
  const text = await (await import('node:fs/promises')).readFile(join(dir, 'person.json'), 'utf8');
  const p = await validInstance(text, { name: 'a', home: { zip: '1' } });
  t.same(p.validate(), { valid: true });
  await t.rejects(validInstance(text, { home: {} }, { logErrorToConsole: false }), { name: 'InitializationError' });
});

t.test('open source schema with remote $refs (SchemaStore)', async (t) => {
  const url = 'https://json.schemastore.org/github-workflow.json';
  const opts = { logErrorToConsole: false, remoteRefs: { enabled: true, allowList: ['json.schemastore.org', 'www.schemastore.org'], maxRedirects: 2, maxBytes: 5 * 1048576, timeoutMs: 20000 } };
  t.capture(console, 'warn');
  let p;
  try {
    p = await validInstance(url, { name: 'ci', on: 'push', jobs: { build: { 'runs-on': 'ubuntu-latest', steps: [{ run: 'echo' }] } } }, opts);
  } catch (e) {
    if (e.code === 'NETWORK' || e.code === 'TIMEOUT') { t.comment(`skipped, no network: ${e.code}`); return; }
    throw e;
  }
  t.same(p.validate(), { valid: true });
});
