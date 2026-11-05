'use strict';

// Rate limits with server.js's real defaults: 5 failed logins per IP + username per 15 min,
// 20 new profiles per IP per hour. Each test uses its own source IP (127.0.0.x all reach the
// server on 127.0.0.1), so they do not share counters.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, MSG } = require('./helpers');

let srv;
before(async () => { srv = await startServer({ realLimits: true }); });
after(() => srv?.close());

/** JSON request sent from a chosen local (source) address. */
function apiFrom(localAddress, method, urlPath, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: srv.port, method, path: urlPath, localAddress, agent: false,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const login = (ip, username, password) => apiFrom(ip, 'POST', '/api/login', { username, password });
const register = (ip, username, password = 'password1') => apiFrom(ip, 'POST', '/api/register', { username, password });

describe('login limit: 5 failed attempts per IP + username per 15 minutes', () => {
  test('after 5 failures the next attempt is 429 { field: password }, even with the right password', async () => {
    const ip = '127.0.0.11';
    assert.equal((await register(ip, 'Target', 'right-password')).status, 201);
    for (let i = 1; i <= 5; i++) {
      const res = await login(ip, 'Target', `wrong-${i}`);
      assert.equal(res.status, 401, `attempt ${i}`);
      assert.deepEqual(res.body, { error: MSG.badLogin, field: 'password' });
    }
    for (const [username, password] of [['Target', 'wrong-6'], ['Target', 'right-password'], [' TARGET ', 'right-password']]) {
      const res = await login(ip, username, password);
      assert.equal(res.status, 429, `${username} / ${password}`);
      assert.deepEqual(res.body, { error: MSG.tooManyLogins, field: 'password' });
    }
  });

  test('only that IP + username is blocked: other names from that IP and that name from other IPs still work', async () => {
    const [attacker, victimIp, otherIp] = ['127.0.0.12', '127.0.0.13', '127.0.0.14'];
    assert.equal((await register(otherIp, 'Victim', 'victim-password')).status, 201);
    assert.equal((await register(otherIp, 'Bystander', 'bystander-pw')).status, 201);
    for (let i = 0; i < 5; i++) assert.equal((await login(attacker, 'victim', `guess-${i}`)).status, 401);
    assert.equal((await login(attacker, 'victim', 'guess-5')).status, 429);

    assert.equal((await login(victimIp, 'Victim', 'victim-password')).status, 200, 'the real user is not locked out');
    assert.equal((await login(attacker, 'Bystander', 'bystander-pw')).status, 200, 'other usernames from that IP work');
  });

  test('a successful login resets the counter', async () => {
    const ip = '127.0.0.15';
    assert.equal((await register(ip, 'Forgetful', 'right-password')).status, 201);
    for (let i = 0; i < 4; i++) assert.equal((await login(ip, 'Forgetful', `oops-${i}`)).status, 401);
    assert.equal((await login(ip, 'Forgetful', 'right-password')).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await login(ip, 'Forgetful', `again-${i}`)).status, 401, `after reset ${i + 1}`);
    assert.equal((await login(ip, 'Forgetful', 'again-5')).status, 429);
  });

  test('parallel guesses are counted before the password check: of 20 at once only 5 are checked', async () => {
    const ip = '127.0.0.16';
    assert.equal((await register(ip, 'Burst', 'right-password')).status, 201);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => login(ip, 'Burst', `burst-${i}`)));
    const count = status => results.filter(r => r.status === status).length;
    assert.deepEqual({ 401: count(401), 429: count(429) }, { 401: 5, 429: 15 });
  });

  test('unknown usernames are limited the same way, with the same answers (no user enumeration)', async () => {
    const ip = '127.0.0.17';
    for (let i = 0; i < 5; i++) {
      const res = await login(ip, 'ghost-user', `x-${i}`);
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: MSG.badLogin, field: 'password' });
    }
    const res = await login(ip, 'ghost-user', 'x-5');
    assert.equal(res.status, 429);
    assert.deepEqual(res.body, { error: MSG.tooManyLogins, field: 'password' });
  });
});

describe('registration limit: 20 new profiles per IP per hour', () => {
  test('the 21st profile from one IP is a 429; refused attempts do not count; other IPs are unaffected', async () => {
    const ip = '127.0.0.21';
    // Invalid input is refused before anything is counted
    assert.equal((await register(ip, 'x')).status, 400);
    assert.equal((await register(ip, 'okname', 'short')).status, 400);
    for (let i = 0; i < 20; i++) assert.equal((await register(ip, `bulk_${i}`)).status, 201, `profile ${i + 1}`);
    assert.equal((await register(ip, 'bulk_0')).status, 409, 'a taken name is still a 409');

    const res = await register(ip, 'bulk_20');
    assert.equal(res.status, 429);
    assert.deepEqual(res.body, { error: MSG.tooManyRegistrations });
    assert.equal((await login(ip, 'bulk_20', 'password1')).status, 401, 'the refused profile was not created');
    assert.equal((await register('127.0.0.22', 'bulk_20')).status, 201, 'another IP can still register');
  });
});
