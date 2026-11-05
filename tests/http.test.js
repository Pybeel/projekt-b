'use strict';

// HTTP-level behaviour: API routing errors, JSON parsing, body size limit, static files,
// path traversal and malformed request targets (raw sockets where fetch would normalise).

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, withServer, rawGet, MSG, REPO_DIR } = require('./helpers');

const MAX_BODY = 100 * 1024;
const SERVER_SOURCE_MARKER = "const MAX_BODY = 100 * 1024;";

let srv;
let token;
before(async () => {
  srv = await startServer();
  token = (await srv.register()).token;

  // Fixtures inside the temp copy of public/ (never in the repo) for the MIME table
  const pub = path.join(srv.dir, 'public');
  fs.writeFileSync(path.join(pub, 'fixture.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(pub, 'fixture.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(pub, 'fixture.ico'), Buffer.from([0, 0, 1, 0]));
  fs.writeFileSync(path.join(pub, 'fixture.json'), '{"ok":true}');
  fs.writeFileSync(path.join(pub, 'fixture.unknownext'), 'raw bytes');
  fs.writeFileSync(path.join(pub, 'with space.txt'), 'spaced');
  // A sibling dir whose name starts with "public" must not be reachable either
  fs.mkdirSync(path.join(srv.dir, 'public-secret'));
  fs.writeFileSync(path.join(srv.dir, 'public-secret', 'secret.txt'), 'TOP SECRET');
});
after(() => srv?.close());

/** Raw POST with an exact Content-Length; body is a string. */
function rawPost(target, body, extraHeaders = '') {
  return [
    `POST ${target} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${extraHeaders}\r\n`,
    body
  ];
}
/** A register body padded with a "pad" field to exactly `size` bytes. */
function paddedRegisterBody(size, fields = { username: 'x' }) {
  const head = JSON.stringify({ ...fields, pad: '' });
  return head.slice(0, -2) + 'a'.repeat(size - Buffer.byteLength(head)) + '"}';
}

describe('API routing', () => {
  test('404 "Ukendt API-adresse." for unknown API paths and wrong methods (when logged in)', async () => {
    for (const [method, p] of [
      ['GET', '/api/nope'],
      ['GET', '/api/'],
      ['POST', '/api/me'],
      ['PUT', '/api/me'],
      ['GET', '/api/register'],
      ['GET', '/api/login'],
      ['PATCH', '/api/me/profile'],
      ['GET', '/api/me/profile'],
      ['DELETE', '/api/me/locations/order'],
      ['GET', '/api/me/extra']
    ]) {
      const res = await srv.api(method, p, { token });
      assert.equal(res.status, 404, `${method} ${p}`);
      assert.deepEqual(res.body, { error: MSG.unknownApi }, `${method} ${p}`);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    }
  });

  test('without a token every unknown API path is 401 (auth runs before routing)', async () => {
    for (const p of ['/api/nope', '/api/', '/api/me/extra']) {
      const res = await srv.api('GET', p);
      assert.equal(res.status, 401, p);
      assert.deepEqual(res.body, { error: MSG.loginRequired });
    }
  });

  test('/api without a trailing slash is a static path (plain-text 404, not JSON)', async () => {
    const res = await srv.api('GET', '/api');
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(res.text, 'Ikke fundet');
  });
});

describe('request bodies', () => {
  test('400 { error: "Ugyldig JSON." } (no field) for invalid JSON on public routes', async () => {
    for (const p of ['/api/register', '/api/login']) {
      for (const body of ['{bad', '{"username": "a",}', 'undefined', "{'a':1}"]) {
        const res = await srv.api('POST', p, { body });
        assert.equal(res.status, 400, `${p} ${body}`);
        assert.deepEqual(res.body, { error: MSG.invalidJson });
      }
    }
  });

  test('invalid JSON on a protected route: 401 without a token (auth first), 400 with one', async () => {
    assert.equal((await srv.api('PUT', '/api/me/profile', { body: '{bad' })).status, 401);
    const res = await srv.api('PUT', '/api/me/profile', { token, body: '{bad' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: MSG.invalidJson });
  });

  test('JSON that is not an object (null, number, string) or an empty body is treated as {}', async () => {
    for (const body of ['null', '42', '"text"', 'true', '']) {
      const res = await srv.api('POST', '/api/register', { body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(res.body, { error: MSG.username, field: 'username' });
    }
  });

  test('the Content-Type header is not required', async () => {
    const res = await srv.api('POST', '/api/register', {
      body: JSON.stringify({ username: 'notype', password: 'password1' }),
      headers: { 'Content-Type': 'text/plain' }
    });
    assert.equal(res.status, 201);
  });

  test(`a body of exactly ${MAX_BODY} bytes is still read and parsed`, async () => {
    const body = paddedRegisterBody(MAX_BODY);
    assert.equal(Buffer.byteLength(body), MAX_BODY);
    const res = await srv.raw(rawPost('/api/register', body));
    assert.equal(res.status, 400);
    assert.deepEqual(JSON.parse(res.body), { error: MSG.username, field: 'username' });
  });

  test('an oversized body (> 100 kB) is not processed and the server keeps running', async () => {
    const body = paddedRegisterBody(MAX_BODY + 50_000, { username: 'bigbody', password: 'password1' });
    const res = await srv.raw(rawPost('/api/register', body));
    assert.notEqual(res.status, 201);
    assert.ok(await srv.isAlive(), 'server should survive an oversized body');
    const login = await srv.api('POST', '/api/login', { body: { username: 'bigbody', password: 'password1' } });
    assert.equal(login.status, 401, 'the oversized register must not have created the user');
  });

  test('an oversized body gets a 413 JSON response', {
    todo: 'readBody() calls req.destroy() right after reject(413), so the socket is gone before sendJson runs: the client sees an empty reply / ECONNRESET instead of 413 "Forespørgslen er for stor."'
  }, async () => {
    const res = await srv.raw(rawPost('/api/register', paddedRegisterBody(MAX_BODY + 1)));
    assert.equal(res.status, 413, `got status ${res.status}, error ${res.error?.code}, raw ${JSON.stringify(res.raw.slice(0, 80))}`);
    assert.deepEqual(JSON.parse(res.body), { error: MSG.tooLarge });
  });
});

describe('static files', () => {
  const file = rel => fs.readFileSync(path.join(REPO_DIR, 'public', rel));

  test('GET / serves public/index.html as text/html', async () => {
    for (const p of ['/', '/index.html', '/?utm=x']) {
      const res = await fetch(srv.base + p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      const body = Buffer.from(await res.arrayBuffer());
      assert.ok(body.equals(file('index.html')), p);
    }
  });

  test('serves CSS and JS with the right Content-Type and exact bytes', async () => {
    for (const [p, type] of [
      ['/css/style.css', 'text/css; charset=utf-8'],
      ['/js/app.js', 'text/javascript; charset=utf-8'],
      ['/js/api.js', 'text/javascript; charset=utf-8']
    ]) {
      const res = await fetch(srv.base + p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get('content-type'), type, p);
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(file(p.slice(1))), p);
    }
  });

  test('the rest of the MIME table, and application/octet-stream for unknown extensions', async () => {
    for (const [p, type] of [
      ['/fixture.svg', 'image/svg+xml'],
      ['/fixture.png', 'image/png'],
      ['/fixture.ico', 'image/x-icon'],
      ['/fixture.json', 'application/json; charset=utf-8'],
      ['/fixture.unknownext', 'application/octet-stream']
    ]) {
      const res = await fetch(srv.base + p);
      await res.arrayBuffer();
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get('content-type'), type, p);
    }
  });

  test('percent-encoded paths are decoded', async () => {
    const res = await fetch(srv.base + '/with%20space.txt');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'spaced');
  });

  test('404 "Ikke fundet" (text/plain) for missing files and directories', async () => {
    for (const p of ['/nope.html', '/js/nope.js', '/css/', '/css', '/js/', '/data/users.json', '/server.js']) {
      const res = await fetch(srv.base + p);
      assert.equal(res.status, 404, p);
      assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8', p);
      assert.equal(await res.text(), 'Ikke fundet', p);
    }
  });

  test('400 "Bad request" for a malformed percent-encoding', async () => {
    const res = await srv.raw(rawGet('/%E0%A4%A'));
    assert.equal(res.status, 400);
    assert.equal(res.body, 'Bad request');
  });

  test('path traversal over a raw socket never escapes public/ (403 or 404)', async () => {
    for (const [target, status] of [
      ['/../server.js', 404],              // dot segments are resolved by new URL() first
      ['/../../../../etc/passwd', 404],
      ['/css/../../server.js', 404],
      ['/%2e%2e/server.js', 404],          // %2e%2e is also a dot segment for new URL()
      ['/..%2fserver.js', 403],            // encoded slash: decoded after URL parsing
      ['/%2e%2e%2fserver.js', 403],
      ['/css/..%2f..%2fserver.js', 403],
      ['/..%2fdata%2fusers.json', 403],
      ['/..%2f..%2f..%2f..%2fetc%2fpasswd', 403],
      ['/..%2fpublic-secret%2fsecret.txt', 403], // sibling dir sharing the "public" prefix
      ['/..%5cserver.js', 404],            // backslash is a normal filename char on POSIX
      ['/x%00.js', 404]                    // NUL byte
    ]) {
      const res = await srv.raw(rawGet(target));
      assert.equal(res.status, status, target);
      assert.ok(!res.body.includes(SERVER_SOURCE_MARKER), `${target} leaked server.js`);
      assert.ok(!res.body.includes('TOP SECRET'), `${target} leaked public-secret/`);
      assert.ok(!res.body.includes('root:'), `${target} leaked /etc/passwd`);
    }
    assert.ok(await srv.isAlive());
  });

  test('an absolute-form request target is served by its path only', async () => {
    const res = await srv.raw(rawGet('http://evil.example/js/api.js'));
    assert.equal(res.status, 200);
    assert.equal(res.body, file('js/api.js').toString('utf8'));
  });

  test('405 with an empty body for non-GET/HEAD methods on static paths', async () => {
    for (const [method, p] of [['POST', '/'], ['POST', '/index.html'], ['PUT', '/css/style.css'], ['DELETE', '/js/app.js'], ['PATCH', '/'], ['POST', '/nope']]) {
      const res = await fetch(srv.base + p, { method });
      assert.equal(res.status, 405, `${method} ${p}`);
      assert.equal(await res.text(), '', `${method} ${p}`);
    }
  });

  test('405 responses carry an Allow: GET, HEAD header', {
    todo: 'serveStatic() answers 405 without an Allow header (RFC 9110 §15.5.6 says the server MUST send one)'
  }, async () => {
    const res = await fetch(srv.base + '/', { method: 'POST' });
    await res.arrayBuffer();
    assert.equal(res.status, 405);
    assert.match(res.headers.get('allow') || '', /^GET,\s*HEAD$/);
  });

  test('HEAD returns the headers without a body', async () => {
    const res = await fetch(srv.base + '/', { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await res.text(), '');

    const raw = await srv.raw(rawGet('/css/style.css', 'HEAD'));
    assert.equal(raw.status, 200);
    assert.equal(raw.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(raw.body, '');

    const missing = await fetch(srv.base + '/nope.html', { method: 'HEAD' });
    assert.equal(missing.status, 404);
  });
});

describe('malformed request targets', () => {
  // new URL(req.url, 'http://localhost') runs outside the try/catch in the request handler,
  // so an unparsable target rejects the async handler -> unhandled rejection -> process exit.
  // Each test gets its own throwaway server because the current code dies.
  for (const target of ['http://[', '//[']) {
    test(`"GET ${target} HTTP/1.1" gets a 400 and the server keeps running`, {
      todo: `new URL() throws "Invalid URL" outside the try/catch: one "GET ${target}" request kills the whole server process (remote DoS)`
    }, () => withServer(async s => {
      const res = await s.raw(rawGet(target));
      if (!(await s.isAlive())) {
        const code = await s.waitForExit();
        const reason = s.logs.stderr.split('\n').find(l => /Error/.test(l)) || 'no stderr';
        assert.fail(`server process died (exit ${code}: ${reason.trim()}); response was ${JSON.stringify(res.raw)}`);
      }
      assert.equal(res.status, 400);
    }));
  }

  test('targets Node\'s parser rejects itself get a 400 and do not affect the server', async () => {
    const res = await srv.raw(rawGet('http://a b'));
    assert.equal(res.status, 400);
    assert.ok(await srv.isAlive());
  });
});
