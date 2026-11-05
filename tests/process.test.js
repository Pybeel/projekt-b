'use strict';

// The server process itself: startup line, a port that is already taken, client aborts.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, withServer } = require('./helpers');

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
