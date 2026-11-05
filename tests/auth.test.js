'use strict';

// Accounts and sessions: register, login, logout, GET /api/me, DELETE /api/me.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, MSG } = require('./helpers');

const TOKEN_RE = /^[a-f0-9]{64}$/;
const DEFAULT_PROFILE = {
  displayName: '',
  ageGroup: null,
  coldSensitivity: 'normal',
  transport: null,
  wardrobe: null,
  onboarded: false
};

let srv;
before(async () => { srv = await startServer(); });
after(() => srv?.close());

const register = body => srv.api('POST', '/api/register', { body });
const login = body => srv.api('POST', '/api/login', { body });
const me = (token, headers) => srv.api('GET', '/api/me', { token, headers });

describe('POST /api/register', () => {
  test('201 returns exactly { token, user } with a 64-hex token and the public user shape', async () => {
    const res = await register({ username: 'Alice', password: 'password1' });
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body).sort(), ['token', 'user']);
    assert.match(res.body.token, TOKEN_RE);

    const { user } = res.body;
    assert.deepEqual(Object.keys(user).sort(), ['createdAt', 'locations', 'profile', 'username']);
    assert.equal(user.username, 'Alice', 'original casing is kept for display');
    assert.equal(new Date(user.createdAt).toISOString(), user.createdAt);
    assert.ok(Math.abs(Date.now() - Date.parse(user.createdAt)) < 60_000);
    assert.deepEqual(user.profile, DEFAULT_PROFILE);
    assert.deepEqual(user.locations, []);
  });

  test('never leaks salt, hash or the password', async () => {
    const res = await register({ username: 'leakcheck', password: 'super-secret-pw' });
    assert.equal(res.status, 201);
    assert.doesNotMatch(res.text, /salt|hash|super-secret-pw/i);
  });

  test('the returned token works for GET /api/me', async () => {
    const { token } = await srv.register({ username: 'tokenworks' });
    const res = await me(token);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'tokenworks');
  });

  test('API responses are JSON with Cache-Control: no-store', async () => {
    const res = await register({ username: 'headers1', password: 'password1' });
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  for (const [why, username] of [
    ['too short (2 chars)', 'ab'],
    ['too long (25 chars)', 'a'.repeat(25)],
    ['contains a space', 'bad name'],
    ['contains non-ASCII letters', 'blåbær'],
    ['contains a slash', 'a/b'],
    ['contains @', 'me@example'],
    ['is empty', ''],
    ['is only whitespace', '     ']
  ]) {
    test(`400 { field: 'username' } when the username ${why}`, async () => {
      const res = await register({ username, password: 'password1' });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: MSG.username, field: 'username' });
    });
  }

  test('400 { field: username } when username is missing or not a string-like value', async () => {
    for (const body of [{ password: 'password1' }, { username: null, password: 'password1' }, {}]) {
      const res = await register(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(res.body, { error: MSG.username, field: 'username' });
    }
  });

  test('accepts the boundary lengths 3 and 24 and the characters . _ -', async () => {
    for (const username of ['abc', 'x'.repeat(24), 'a.b_c-D9']) {
      const res = await register({ username, password: 'password1' });
      assert.equal(res.status, 201, username);
      assert.equal(res.body.user.username, username);
    }
  });

  test('trims whitespace around the username before validating and storing it', async () => {
    const res = await register({ username: '  spaced  ', password: 'password1' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.username, 'spaced');
    assert.equal((await login({ username: 'spaced', password: 'password1' })).status, 200);
  });

  test('400 { field: password } when the password is shorter than 8 chars; 8 is accepted', async () => {
    const short = await register({ username: 'shortpw', password: '1234567' });
    assert.equal(short.status, 400);
    assert.deepEqual(short.body, { error: MSG.password, field: 'password' });

    const missing = await register({ username: 'nopw' });
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body, { error: MSG.password, field: 'password' });

    const ok = await register({ username: 'exactly8', password: '12345678' });
    assert.equal(ok.status, 201);
  });

  test('the password is not trimmed (spaces count towards the length)', async () => {
    const res = await register({ username: 'spacepw', password: '   ab   ' });
    assert.equal(res.status, 201);
    assert.equal((await login({ username: 'spacepw', password: 'ab' })).status, 401);
    assert.equal((await login({ username: 'spacepw', password: '   ab   ' })).status, 200);
  });

  test('the username is validated before the password', async () => {
    const res = await register({ username: 'x', password: 'y' });
    assert.equal(res.status, 400);
    assert.equal(res.body.field, 'username');
  });

  test('409 { field: username } for a duplicate username, case-insensitively', async () => {
    await srv.register({ username: 'Bob' });
    for (const username of ['Bob', 'bob', 'BOB', ' bOb ']) {
      const res = await register({ username, password: 'another-pw' });
      assert.equal(res.status, 409, username);
      assert.deepEqual(res.body, { error: MSG.taken, field: 'username' });
    }
  });

  test('concurrent registrations of the same name: exactly one wins, the rest get 409', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => register({ username: i % 2 ? 'RACER' : 'racer', password: 'password1' }))
    );
    const statuses = results.map(r => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409]);
  });

  test('an optional profile in the register body is sanitized and stored', async () => {
    const res = await register({
      username: 'withprofile',
      password: 'password1',
      profile: { coldSensitivity: 'fryser', ageGroup: 'bogus', displayName: '  Ann  ', isAdmin: true }
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.user.profile, { ...DEFAULT_PROFILE, coldSensitivity: 'fryser', displayName: 'Ann' });
  });

  test('usernames that look like Object.prototype members but are not lowercase keys work (toString, valueOf, hasOwnProperty)', async () => {
    // Keys in db.users are lowercased, so "toString" is stored as "tostring" and is harmless.
    for (const username of ['toString', 'valueOf', 'hasOwnProperty']) {
      const reg = await register({ username, password: 'password1' });
      assert.equal(reg.status, 201, username);
      const res = await login({ username, password: 'password1' });
      assert.equal(res.status, 200, username);
      assert.equal(res.body.user.username, username);
    }
  });

  // db.users used to be a plain object, so db.users['__proto__'] / db.users['constructor'] were
  // inherited values (Object.prototype / Object) rather than undefined. Now they are ordinary names.
  for (const username of ['__proto__', 'constructor']) {
    test(`the valid-looking username "${username}" is an ordinary free username`, async () => {
      const res = await register({ username, password: 'password1' });
      assert.equal(res.status, 201, `got ${res.status} ${res.text}`);
      const again = await login({ username, password: 'password1' });
      assert.equal(again.status, 200);
      assert.equal((await me(again.body.token)).body.user.username, username);
      // ...and it must not have polluted the user table for everyone else
      const other = await srv.register();
      assert.equal((await me(other.token)).status, 200);
    });
  }
});

describe('POST /api/login', () => {
  let alice;
  before(async () => { alice = await srv.register({ username: 'LoginUser', password: 'right-password' }); });

  test('200 { token, user } with a new token; the register token stays valid too', async () => {
    const res = await login({ username: 'LoginUser', password: 'right-password' });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['token', 'user']);
    assert.match(res.body.token, TOKEN_RE);
    assert.notEqual(res.body.token, alice.token);
    assert.deepEqual(res.body.user, alice.user);
    assert.doesNotMatch(res.text, /salt|hash|right-password/);
    assert.equal((await me(res.body.token)).status, 200);
    assert.equal((await me(alice.token)).status, 200);
  });

  test('the username is case-insensitive and trimmed; the stored casing is returned', async () => {
    for (const username of ['loginuser', 'LOGINUSER', '  LoginUser  ']) {
      const res = await login({ username, password: 'right-password' });
      assert.equal(res.status, 200, username);
      assert.equal(res.body.user.username, 'LoginUser');
    }
  });

  test('401 { field: password } for a wrong password (passwords are case-sensitive)', async () => {
    for (const password of ['wrong-password', 'RIGHT-PASSWORD', '', 'right-password ']) {
      const res = await login({ username: 'LoginUser', password });
      assert.equal(res.status, 401, JSON.stringify(password));
      assert.deepEqual(res.body, { error: MSG.badLogin, field: 'password' });
    }
  });

  test('401 with the same body for an unknown user (no user enumeration)', async () => {
    const res = await login({ username: 'nobody-here', password: 'right-password' });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: MSG.badLogin, field: 'password' });
  });

  test('401 for an empty body or missing fields', async () => {
    for (const body of [{}, { username: 'LoginUser' }, { password: 'right-password' }]) {
      const res = await login(body);
      assert.equal(res.status, 401, JSON.stringify(body));
      assert.deepEqual(res.body, { error: MSG.badLogin, field: 'password' });
    }
  });

  // Used to be a 500: db.users["__proto__"] was Object.prototype, so verifyPassword() got salt undefined.
  for (const username of ['__proto__', 'constructor', 'Constructor', '__PROTO__']) {
    test(`logging in as "${username}" with the wrong password is a normal 401`, async () => {
      // Not the password used in the register test above, so this is a 401 whether or not
      // that test managed to create the account.
      const res = await login({ username, password: 'not-the-password' });
      assert.equal(res.status, 401, `got ${res.status} ${res.text}`);
      assert.deepEqual(res.body, { error: MSG.badLogin, field: 'password' });
    });
  }
});

describe('POST /api/logout', () => {
  test('200 { ok: true } and that token is invalid afterwards; other sessions stay valid', async () => {
    const u = await srv.register();
    const second = await login({ username: u.username, password: u.password });

    const res = await srv.api('POST', '/api/logout', { token: u.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });

    assert.equal((await me(u.token)).status, 401);
    assert.equal((await me(second.body.token)).status, 200);
    assert.equal((await srv.api('POST', '/api/logout', { token: u.token })).status, 401, 'cannot log out twice');
  });

  test('401 without a token', async () => {
    const res = await srv.api('POST', '/api/logout');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: MSG.loginRequired });
  });
});

describe('GET /api/me', () => {
  let u;
  before(async () => { u = await srv.register(); });

  test('200 { user } with the public user shape', async () => {
    const res = await me(u.token);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['user']);
    assert.deepEqual(res.body.user, u.user);
    assert.doesNotMatch(res.text, /salt|hash/);
  });

  test('401 { error } without an Authorization header', async () => {
    const res = await me();
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: MSG.loginRequired });
  });

  test('401 for a well-formed but unknown token', async () => {
    const res = await me('0'.repeat(64));
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: MSG.loginRequired });
  });

  test('401 for malformed Authorization headers', async () => {
    const t = u.token;
    for (const authorization of [
      'Bearer',
      'Bearer ',
      'Bearer abc',
      `Bearer ${t.slice(1)}`,           // 63 hex
      `Bearer ${t}0`,                   // 65 hex
      `Bearer ${t.slice(1)}g`,          // non-hex char
      `Token ${t}`,
      `Basic ${t}`,
      t,                                // no scheme
      `Bearer ${t} extra`,
      `Bearer ${t.toUpperCase()}`       // tokens are matched exactly (lowercase hex)
    ]) {
      const res = await me(undefined, { Authorization: authorization });
      assert.equal(res.status, 401, authorization);
      assert.deepEqual(res.body, { error: MSG.loginRequired });
    }
  });

  test('the Bearer scheme is matched case-insensitively and may be followed by several spaces', async () => {
    for (const authorization of [`bearer ${u.token}`, `BEARER ${u.token}`, `Bearer    ${u.token}`]) {
      const res = await me(undefined, { Authorization: authorization });
      assert.equal(res.status, 200, authorization);
    }
  });

  test('a query string does not change routing', async () => {
    const res = await srv.api('GET', '/api/me?foo=bar', { token: u.token });
    assert.equal(res.status, 200);
  });
});

describe('DELETE /api/me', () => {
  test('deletes the user and every one of their sessions; other users are unaffected', async () => {
    const victim = await srv.register({ username: 'DeleteMe', password: 'password1' });
    const victimSecond = (await login({ username: 'deleteme', password: 'password1' })).body.token;
    const bystander = await srv.register();

    const res = await srv.api('DELETE', '/api/me', { token: victim.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });

    assert.equal((await me(victim.token)).status, 401);
    assert.equal((await me(victimSecond)).status, 401);
    assert.equal((await login({ username: 'DeleteMe', password: 'password1' })).status, 401);

    const other = await me(bystander.token);
    assert.equal(other.status, 200);
    assert.deepEqual(other.body.user, bystander.user);
    assert.equal((await login({ username: bystander.username, password: bystander.password })).status, 200);
  });

  test('the username is free again after deletion', async () => {
    const u = await srv.register({ username: 'Reusable' });
    await srv.api('DELETE', '/api/me', { token: u.token });
    const res = await register({ username: 'reusable', password: 'new-password' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.username, 'reusable');
  });

  test('401 without a token', async () => {
    const res = await srv.api('DELETE', '/api/me');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: MSG.loginRequired });
  });
});
