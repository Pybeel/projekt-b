'use strict';

// The server process itself: startup line, a port that is already taken, client aborts,
// graceful shutdown on SIGTERM / SIGINT.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startServer, withServer } = require('./helpers');

/** Poll until fn() is true (or fail after `ms`). */
async function until(fn, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

test('the startup line shows the HOST and PORT the server really listens on', () => withServer(async srv => {
  assert.match(srv.logs.stdout, new RegExp(`Klädd kører på\\s+http://127\\.0\\.0\\.1:${srv.port}\\b`));
}));

test('a port that is already in use gives a short Danish message and exit code 1, not a stack trace', () => withServer(async srv => {
  const err = await startServer({ port: srv.port }).then(
    second => { second.close(); assert.fail('second server should not start'); },
    e => e
  );
  assert.equal(err.code, 1, err.message);
  assert.match(err.logs.stderr, new RegExp(`Porten ${srv.port} er optaget`));
  assert.doesNotMatch(err.logs.stderr, /\n\s+at /, 'no stack trace');
  assert.ok(await srv.isAlive(), 'the first server is unaffected');
}));

test('a client that hangs up in the middle of a body is not logged as a server error', () => withServer(async srv => {
  // Promise a 1000-byte body, send 10 bytes, then close the socket.
  const res = await srv.raw([
    'POST /api/register HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n',
    '{"username'
  ], { timeout: 300 });
  assert.equal(res.status, null, 'no response: the client gave up first');
  await new Promise(r => setTimeout(r, 200));
  assert.ok(await srv.isAlive());
  assert.equal(srv.logs.stderr, '', 'nothing logged for an aborted request');
}));

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal}: the server says so in Danish, saves and exits with code 0`, async () => {
    const srv = await startServer();
    try {
      const u = await srv.register({ username: `Bye${signal}`, password: 'goodbye-pw' });
      await srv.api('PUT', '/api/me/profile', { token: u.token, body: { displayName: 'Farvel' } });
      srv.child.kill(signal);
      assert.equal(await srv.waitForExit(3000), 0, srv.logs.stderr);
      assert.match(srv.logs.stdout, /Stopper Klädd/);
      assert.equal(srv.logs.stderr, '');
    } finally {
      await srv.close();
    }
  });
}

test('on SIGTERM a request that is already in progress still completes and is saved; new connections are refused', async () => {
  const first = await startServer();
  let second;
  try {
    const body = JSON.stringify({ username: 'LastOne', password: 'last-one-pw' });
    const sock = net.connect(first.port, '127.0.0.1');
    let response = '';
    sock.on('data', c => { response += c; });
    const closed = new Promise(r => sock.on('close', r));
    await new Promise(r => sock.on('connect', r));
    // Headers and half the body now ...
    sock.write(`POST /api/register HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.slice(0, 10)}`);
    await new Promise(r => setTimeout(r, 100));

    first.child.kill('SIGTERM');
    await until(() => first.logs.stdout.includes('Stopper Klädd'), 'the shutdown message');
    await assert.rejects(fetch(first.base + '/'), 'no new connections once shutdown has started');

    // ... the rest of the body after the signal
    sock.write(body.slice(10));
    await closed;
    assert.match(response, /^HTTP\/1\.1 201 /, response);
    assert.equal(await first.waitForExit(3000), 0);

    second = await startServer({ dir: first.dir });
    const login = await second.api('POST', '/api/login', { body: { username: 'lastone', password: 'last-one-pw' } });
    assert.equal(login.status, 200, 'the account created during shutdown was saved');
  } finally {
    await first.stop();
    if (second) await second.close();
    else await first.close();
  }
});
