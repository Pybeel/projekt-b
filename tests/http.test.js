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

  test('an oversized body gets a 413 JSON response and Connection: close', async () => {
    const res = await srv.raw(rawPost('/api/register', paddedRegisterBody(MAX_BODY + 1)));
    assert.equal(res.status, 413, `got status ${res.status}, error ${res.error?.code}, raw ${JSON.stringify(res.raw.slice(0, 80))}`);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers.connection, 'close');
    assert.deepEqual(JSON.parse(res.body), { error: MSG.tooLarge });
  });

  test('a Content-Length over the limit is answered with 413 before the body is even sent', async () => {
    // Only the headers: the server must not wait for the 200 kB it was promised
    const res = await srv.raw(
      `POST /api/register HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${2 * MAX_BODY}\r\n\r\n`,
      { timeout: 1500 }
    );
    assert.equal(res.status, 413, `got ${res.status} ${res.error?.message || ''}`);
    assert.deepEqual(JSON.parse(res.body), { error: MSG.tooLarge });
    assert.ok(await srv.isAlive());
  });

  test('an oversized chunked body (no Content-Length) also gets a 413 JSON response', async () => {
    const body = paddedRegisterBody(MAX_BODY + 50_000, { username: 'chunky', password: 'password1' });
    const chunks = [];
    for (let i = 0; i < body.length; i += 16_384) {
      const part = body.slice(i, i + 16_384);
      chunks.push(`${Buffer.byteLength(part).toString(16)}\r\n${part}\r\n`);
    }
    const res = await srv.raw([
      'POST /api/register HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n',
      ...chunks,
      '0\r\n\r\n'
    ]);
    assert.equal(res.status, 413, `got status ${res.status}, error ${res.error?.code}`);
    assert.equal(res.headers.connection, 'close');
    assert.deepEqual(JSON.parse(res.body), { error: MSG.tooLarge });
    assert.ok(await srv.isAlive());
    const login = await srv.api('POST', '/api/login', { body: { username: 'chunky', password: 'password1' } });
    assert.equal(login.status, 401, 'the oversized register must not have created the user');
  });

  test('a chunked body just under the limit is still read', async () => {
    const body = paddedRegisterBody(MAX_BODY - 10);
    const res = await srv.raw([
      'POST /api/register HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n',
      `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`
    ]);
    assert.equal(res.status, 400);
    assert.deepEqual(JSON.parse(res.body), { error: MSG.username, field: 'username' });
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

  test('400 "Ugyldig adresse." (text/plain, Danish) for a malformed percent-encoding', async () => {
    // Used to be an untyped English "Bad request"
    const res = await srv.raw(rawGet('/%E0%A4%A'));
    assert.equal(res.status, 400);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(res.body, 'Ugyldig adresse.');
  });

  test('403 "Ingen adgang." (text/plain, Danish) for an encoded path that escapes public/', async () => {
    // Used to be an untyped English "Forbidden"
    const res = await srv.raw(rawGet('/..%2fserver.js'));
    assert.equal(res.status, 403);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(res.body, 'Ingen adgang.');
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

  test('405 responses carry an Allow: GET, HEAD header', async () => {
    const res = await fetch(srv.base + '/', { method: 'POST' });
    await res.arrayBuffer();
    assert.equal(res.status, 405);
    assert.match(res.headers.get('allow') || '', /^GET,\s*HEAD$/);
  });

  test('HEAD returns the headers, including the real Content-Length, without a body', async () => {
    const res = await fetch(srv.base + '/', { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('content-length'), String(file('index.html').length));
    assert.equal(await res.text(), '');

    const raw = await srv.raw(rawGet('/css/style.css', 'HEAD'));
    assert.equal(raw.status, 200);
    assert.equal(raw.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(raw.headers['content-length'], String(file('css/style.css').length));
    assert.equal(raw.body, '');

    const missing = await fetch(srv.base + '/nope.html', { method: 'HEAD' });
    assert.equal(missing.status, 404);
  });
});

describe('security headers', () => {
  const SECURITY = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY'
  };
  const check = (headers, what) => {
    const get = name => (typeof headers.get === 'function' ? headers.get(name) : headers[name]);
    for (const [name, value] of Object.entries(SECURITY)) assert.equal(get(name), value, `${what}: ${name}`);
    return get;
  };
  const cspOf = text => Object.fromEntries(text.split(';').map(d => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

  test('every static response has nosniff, Referrer-Policy, X-Frame-Options and the CSP', async () => {
    for (const [method, p, status] of [['GET', '/', 200], ['GET', '/js/app.js', 200], ['HEAD', '/', 200], ['GET', '/nope', 404], ['POST', '/', 405]]) {
      const res = await fetch(srv.base + p, { method });
      await res.arrayBuffer();
      assert.equal(res.status, status, `${method} ${p}`);
      const get = check(res.headers, `${method} ${p}`);
      const csp = cspOf(get('content-security-policy') || '');
      assert.deepEqual(csp['script-src'], ["'self'"], `${method} ${p}: scripts only from our own server`);
      assert.deepEqual(csp['object-src'], ["'none'"]);
      assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
      assert.deepEqual(csp['default-src'], ["'self'"]);
    }
    for (const target of ['/%E0%A4%A', '/..%2fserver.js']) check((await srv.raw(rawGet(target))).headers, target);
  });

  test('API responses (also errors and a bad address) have the security headers too', async () => {
    check((await srv.api('GET', '/api/me', { token })).headers, 'GET /api/me');
    check((await srv.api('GET', '/api/me')).headers, '401');
    check((await srv.api('GET', '/api/nope', { token })).headers, '404');
    check((await srv.api('POST', '/api/register', { body: '{bad' })).headers, '400');
    check((await srv.raw(rawGet('//['))).headers, 'GET //[');
  });

  test('the CSP allows every external host the frontend uses, and public/ has no inline scripts', async () => {
    // If the frontend starts using a new external service, add it to CSP in server.js.
    const res = await fetch(srv.base + '/');
    await res.arrayBuffer();
    const csp = cspOf(res.headers.get('content-security-policy'));
    const allowed = [...csp['connect-src'], ...csp['style-src'], ...csp['font-src']];

    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else if (/\.(html|js|css)$/.test(e.name)) files.push(path.join(dir, e.name));
      }
    })(path.join(REPO_DIR, 'public'));
    const origins = new Set();
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const [origin] of text.matchAll(/https?:\/\/[a-z0-9.-]+/gi)) {
        if (origin !== 'http://www.w3.org') origins.add(origin);   // the SVG namespace is not a request
      }
      assert.doesNotMatch(text, /<script(?![^>]*\bsrc=)[^>]*>/i, `${f}: an inline <script> would be blocked by script-src 'self'`);
      assert.doesNotMatch(text, /\son[a-z]+\s*=\s*["'`]/i, `${f}: an inline event handler would be blocked`);
      assert.doesNotMatch(text, /\beval\(|new Function\(/, `${f}: eval would be blocked`);
    }
    assert.ok(origins.size >= 5, `found only ${[...origins]}`);
    for (const origin of origins) assert.ok(allowed.includes(origin), `${origin} is used in public/ but not allowed by the CSP`);
  });
});

describe('malformed request targets', () => {
  // new URL() throws on these targets. That used to happen outside the try/catch in the
  // request handler (unhandled rejection -> process exit), so each test gets its own
  // throwaway server: a regression kills only that one.
  for (const target of ['http://[', '//[']) {
    test(`"GET ${target} HTTP/1.1" gets a 400 JSON "Ugyldig adresse." and the server keeps running`, () => withServer(async s => {
      const res = await s.raw(rawGet(target));
      if (!(await s.isAlive())) {
        const code = await s.waitForExit();
        const reason = s.logs.stderr.split('\n').find(l => /Error/.test(l)) || 'no stderr';
        assert.fail(`server process died (exit ${code}: ${reason.trim()}); response was ${JSON.stringify(res.raw)}`);
      }
      assert.equal(res.status, 400);
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
      assert.deepEqual(JSON.parse(res.body), { error: MSG.badAddress });
      assert.equal(s.logs.stderr, '', 'a bad address is not a server error');
    }));
  }

  test('targets Node\'s parser rejects itself get a 400 and do not affect the server', async () => {
    const res = await srv.raw(rawGet('http://a b'));
    assert.equal(res.status, 400);
    assert.ok(await srv.isAlive());
  });
});
