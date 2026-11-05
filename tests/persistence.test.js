'use strict';

// data/users.json + data/sessions.json: what is written, and what survives a restart.
// Every test runs its own server(s) in its own temp dir.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
/** sessions.json is keyed by sha256(token), never by the token itself. */
const sid = token => crypto.createHash('sha256').update(token).digest('hex');

/**
 * login and logout both await their sessions.json write, and writes to a file happen in order,
 * so after this the file reflects every change made so far (e.g. the startup clean-up).
 */
async function flushSessions(srv, username, password) {
  const { body } = await srv.api('POST', '/api/login', { body: { username, password } });
  const res = await srv.api('POST', '/api/logout', { token: body.token });
  assert.equal(res.status, 200);
}

test('users, profiles, locations and sessions survive a restart', async () => {
  const first = await startServer();
  let second;
  try {
    const alice = await first.register({ username: 'Persist', password: 'persist-pw' });
    await first.api('PUT', '/api/me/profile', {
      token: alice.token,
      body: { displayName: 'Per', ageGroup: '18-29', coldSensitivity: 'fryser', transport: 'cykel', wardrobe: ['hue', 'vanter'], onboarded: true }
    });
    const home = (await first.api('POST', '/api/me/locations', { token: alice.token, body: { name: 'Kolding', label: 'Hjem', lat: 55.49, lon: 9.47 } })).body.location;
    const work = (await first.api('POST', '/api/me/locations', { token: alice.token, body: { name: 'Odense', lat: 55.4, lon: 10.39 } })).body.location;
    await first.api('PUT', '/api/me/locations/order', { token: alice.token, body: { ids: [work.id, home.id] } });

    const loggedOut = (await first.api('POST', '/api/login', { body: { username: 'persist', password: 'persist-pw' } })).body.token;
    await first.api('POST', '/api/logout', { token: loggedOut });

    const gone = await first.register({ username: 'Deleted', password: 'deleted-pw' });
    assert.equal((await first.api('DELETE', '/api/me', { token: gone.token })).status, 200); // awaits both files

    const before = (await first.api('GET', '/api/me', { token: alice.token })).body.user;
    assert.deepEqual(before.locations.map(l => l.label), ['Odense', 'Hjem']);

    await first.stop();
    second = await startServer({ dir: first.dir });
    assert.notEqual(second.port, first.port);

    const login = await second.api('POST', '/api/login', { body: { username: 'PERSIST', password: 'persist-pw' } });
    assert.equal(login.status, 200);
    assert.deepEqual(login.body.user, before);
    assert.equal((await second.api('POST', '/api/login', { body: { username: 'persist', password: 'wrong-pw!' } })).status, 401);

    const me = await second.api('GET', '/api/me', { token: alice.token });
    assert.equal(me.status, 200, 'a token issued before the restart still works');
    assert.deepEqual(me.body.user, before);
    assert.equal((await second.api('GET', '/api/me', { token: loggedOut })).status, 401, 'logged-out token stays dead');

    assert.equal((await second.api('GET', '/api/me', { token: gone.token })).status, 401, 'deleted account stays deleted');
    assert.equal((await second.api('POST', '/api/login', { body: { username: 'deleted', password: 'deleted-pw' } })).status, 401);
    assert.equal((await second.api('POST', '/api/register', { body: { username: 'persist', password: 'x'.repeat(8) } })).status, 409);
  } finally {
    await first.stop();
    if (second) await second.close();
    else await first.close();
  }
});

test('data files live in the temp copy and never contain the password', async () => {
  const srv = await startServer();
  try {
    assert.ok(srv.dir.startsWith(fs.realpathSync(os.tmpdir())) || srv.dir.startsWith(os.tmpdir()));
    const u = await srv.register({ username: 'DiskUser', password: 'plaintext-never' });
    await flushSessions(srv, 'diskuser', 'plaintext-never');

    const usersRaw = fs.readFileSync(srv.dataFile('users.json'), 'utf8');
    assert.doesNotMatch(usersRaw, /plaintext-never/);
    const users = JSON.parse(usersRaw);
    assert.deepEqual(Object.keys(users), ['diskuser'], 'keyed by the lowercased username');
    const rec = users.diskuser;
    assert.deepEqual(Object.keys(rec).sort(), ['createdAt', 'hash', 'locations', 'profile', 'salt', 'username']);
    assert.equal(rec.username, 'DiskUser');
    assert.match(rec.salt, /^[a-f0-9]{32}$/);
    assert.match(rec.hash, /^[a-f0-9]{128}$/);

    const sessionsRaw = fs.readFileSync(srv.dataFile('sessions.json'), 'utf8');
    assert.ok(!sessionsRaw.includes(u.token), 'the token itself is never written to disk');
    const sessions = JSON.parse(sessionsRaw);
    assert.deepEqual(Object.keys(sessions), [sid(u.token)], 'only the register session is left, keyed by sha256(token)');
    assert.deepEqual(Object.keys(sessions[sid(u.token)]).sort(), ['created', 'username']);
    assert.equal(sessions[sid(u.token)].username, 'diskuser');
    assert.equal(typeof sessions[sid(u.token)].created, 'number');
    assert.ok(Math.abs(Date.now() - sessions[sid(u.token)].created) < 60_000);

    for (const name of ['users.json', 'sessions.json']) {
      assert.equal((fs.statSync(srv.dataFile(name)).mode & 0o777).toString(8), '600', `${name} is only readable by its owner`);
    }

    assert.deepEqual(fs.readdirSync(path.join(srv.dir, 'data')).sort(), ['sessions.json', 'users.json'], 'no .tmp files left behind');
  } finally {
    await srv.close();
  }
});

test('parallel profile writes: the file on disk ends up equal to the last in-memory state', async () => {
  const first = await startServer();
  let second;
  try {
    const u = await first.register();
    await Promise.all(Array.from({ length: 25 }, (_, i) =>
      first.api('PUT', '/api/me/profile', { token: u.token, body: { displayName: `name ${i}` } })));
    const live = (await first.api('GET', '/api/me', { token: u.token })).body.user;
    await first.stop();

    second = await startServer({ dir: first.dir });
    const login = await second.api('POST', '/api/login', { body: { username: u.username, password: u.password } });
    assert.deepEqual(login.body.user, live);
  } finally {
    await first.stop();
    if (second) await second.close();
    else await first.close();
  }
});

test('sessions older than 30 days are dropped at startup; younger ones survive', async () => {
  const first = await startServer();
  let second;
  try {
    const u = await first.register({ username: 'Ttl', password: 'ttl-password' });
    const young = (await first.api('POST', '/api/login', { body: { username: 'ttl', password: 'ttl-password' } })).body.token;
    await flushSessions(first, 'ttl', 'ttl-password');
    await first.stop();

    const file = first.dataFile('sessions.json');
    const sessions = readJson(file);
    sessions[sid(u.token)].created = Date.now() - 31 * DAY;
    sessions[sid(young)].created = Date.now() - 29 * DAY;
    fs.writeFileSync(file, JSON.stringify(sessions));

    second = await startServer({ dir: first.dir });
    await flushSessions(second, 'ttl', 'ttl-password');
    assert.ok(!(sid(u.token) in readJson(file)), 'the expired session is removed from the file at startup');
    assert.ok(sid(young) in readJson(file));
    assert.equal((await second.api('GET', '/api/me', { token: u.token })).status, 401, '31-day-old session expired');
    assert.equal((await second.api('GET', '/api/me', { token: young })).status, 200, '29-day-old session still valid');
    assert.equal((await second.api('POST', '/api/login', { body: { username: 'ttl', password: 'ttl-password' } })).status, 200);
  } finally {
    await first.stop();
    if (second) await second.close();
    else await first.close();
  }
});

test('register and login answer only after their session is on disk (no token if it cannot be saved)', async () => {
  const srv = await startServer();
  try {
    const u = await srv.register({ username: 'Durable', password: 'durable-pw' });
    assert.ok(sid(u.token) in readJson(srv.dataFile('sessions.json')), 'register session written before the response');

    // Make the next sessions.json write fail: the .tmp path is a directory
    fs.mkdirSync(srv.dataFile('sessions.json.tmp'));
    const failed = await srv.api('POST', '/api/login', { body: { username: 'durable', password: 'durable-pw' } });
    assert.equal(failed.status, 500, 'a session that is not saved is not handed out');
    assert.equal(failed.body.token, undefined);
    fs.rmdirSync(srv.dataFile('sessions.json.tmp'));

    const { body } = await srv.api('POST', '/api/login', { body: { username: 'durable', password: 'durable-pw' } });
    assert.ok(sid(body.token) in readJson(srv.dataFile('sessions.json')), 'login session written before the response');
  } finally {
    await srv.close();
  }
});

test('at most 10 sessions per user: a new login drops the oldest ones', async () => {
  const srv = await startServer();
  try {
    const u = await srv.register({ username: 'Busy', password: 'busy-password' });
    const other = await srv.register();
    const tokens = [u.token];
    for (let i = 0; i < 12; i++) {
      tokens.push((await srv.api('POST', '/api/login', { body: { username: 'busy', password: 'busy-password' } })).body.token);
    }
    const status = async token => (await srv.api('GET', '/api/me', { token })).status;
    for (const token of tokens.slice(0, 3)) assert.equal(await status(token), 401, 'the 3 oldest are gone');
    for (const token of tokens.slice(3)) assert.equal(await status(token), 200, 'the 10 newest still work');
    assert.equal(await status(other.token), 200, 'other users keep their sessions');
    const onDisk = Object.values(readJson(srv.dataFile('sessions.json')));
    assert.equal(onDisk.filter(s => s.username === 'busy').length, 10);
  } finally {
    await srv.close();
  }
});

test('sessions saved before tokens were hashed (keyed by the plain token) no longer work', async () => {
  // One-time effect of the upgrade: everybody has to log in again.
  const first = await startServer();
  let second;
  try {
    await first.register({ username: 'OldTimer', password: 'old-timer-pw' });
    await first.stop();
    const plain = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(first.dataFile('sessions.json'), JSON.stringify({ [plain]: { username: 'oldtimer', created: Date.now() } }));
    second = await startServer({ dir: first.dir });
    assert.equal((await second.api('GET', '/api/me', { token: plain })).status, 401);
    assert.equal((await second.api('POST', '/api/login', { body: { username: 'oldtimer', password: 'old-timer-pw' } })).status, 200);
  } finally {
    await first.stop();
    if (second) await second.close();
    else await first.close();
  }
});

test('a register whose users.json write fails is rolled back: 500 now, and the name is still free', async () => {
  const first = await startServer();
  let second;
  try {
    await first.register({ username: 'Existing', password: 'existing-pw' });
    fs.mkdirSync(first.dataFile('users.json.tmp'));   // the next users.json write fails (EISDIR)
    const failed = await first.api('POST', '/api/register', { body: { username: 'Unlucky', password: 'unlucky-pw' } });
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: 'Der skete en fejl på serveren.' });
    assert.match(first.logs.stderr, /Kunne ikke gemme/);
    assert.equal((await first.api('POST', '/api/login', { body: { username: 'unlucky', password: 'unlucky-pw' } })).status, 401,
      'the account does not exist in memory either');
    fs.rmdirSync(first.dataFile('users.json.tmp'));

    const retry = await first.api('POST', '/api/register', { body: { username: 'Unlucky', password: 'unlucky-pw' } });
    assert.equal(retry.status, 201, 'retrying works instead of answering 409');
    await first.stop();

    second = await startServer({ dir: first.dir });
    for (const [username, password] of [['unlucky', 'unlucky-pw'], ['existing', 'existing-pw']]) {
      assert.equal((await second.api('POST', '/api/login', { body: { username, password } })).status, 200, username);
    }
  } finally {
    await first.stop();
    if (second) await second.close();
    else await first.close();
  }
});

test('the usernames __proto__ and constructor survive a restart like any other account', async () => {
  const first = await startServer();
  let second;
  try {
    for (const username of ['__proto__', 'Constructor']) await first.register({ username, password: 'proto-pass' });
    const plain = await first.register({ username: 'plain', password: 'proto-pass' });
    await first.stop();
    second = await startServer({ dir: first.dir });
    for (const username of ['__proto__', 'constructor', 'plain']) {
      const res = await second.api('POST', '/api/login', { body: { username, password: 'proto-pass' } });
      assert.equal(res.status, 200, username);
    }
    assert.equal((await second.api('GET', '/api/me', { token: plain.token })).body.user.username, 'plain');
    assert.equal((await second.api('POST', '/api/register', { body: { username: '__PROTO__', password: 'x'.repeat(8) } })).status, 409);
    assert.deepEqual(Object.keys(readJson(second.dataFile('users.json'))).sort(), ['__proto__', 'constructor', 'plain']);
  } finally {
    await first.stop();
    if (second) await second.close();
    else await first.close();
  }
});

test('missing data files start an empty database', async () => {
  const srv = await startServer();
  try {
    assert.deepEqual(fs.readdirSync(path.join(srv.dir, 'data')), [], 'nothing is written until something changes');
    const u = await srv.register({ username: 'FirstEver' });
    assert.equal((await srv.api('GET', '/api/me', { token: u.token })).status, 200);
  } finally {
    await srv.close();
  }
});

test('a corrupt or unreadable data file stops the server with a Danish message and is left untouched', async () => {
  const first = await startServer();
  let second;
  try {
    await first.register({ username: 'Keeper', password: 'keeper-pw' });
    await flushSessions(first, 'keeper', 'keeper-pw');
    await first.stop();
    const goodUsers = fs.readFileSync(first.dataFile('users.json'), 'utf8');

    for (const [name, content] of [
      ['users.json', '{"halfwritten": {'],
      ['users.json', ''],
      ['users.json', 'null'],
      ['users.json', '[1, 2]'],
      ['sessions.json', '{bad json'],
      ['users.json', null]                   // a directory: readFileSync fails with EISDIR
    ]) {
      const file = first.dataFile(name);
      const original = fs.readFileSync(file, 'utf8');
      fs.rmSync(file, { recursive: true });
      if (content === null) fs.mkdirSync(file); else fs.writeFileSync(file, content);

      const err = await startServer({ dir: first.dir }).then(
        srv => { srv.close(); assert.fail(`${name} = ${JSON.stringify(content)}: the server started`); },
        e => e
      );
      const what = `${name} = ${JSON.stringify(content)}`;
      assert.equal(err.code, 1, what);
      assert.ok(err.logs.stderr.includes(file), `${what}: the message names the file\n${err.logs.stderr}`);
      assert.match(err.logs.stderr, content === null ? /kan ikke læses \(EISDIR\)/ : /er ødelagt/, what);
      assert.match(err.logs.stderr, /Serveren starter ikke/, what);
      if (content !== null) assert.equal(fs.readFileSync(file, 'utf8'), content, `${what}: file left as it was`);

      fs.rmSync(file, { recursive: true });
      fs.writeFileSync(file, original);
    }

    assert.equal(fs.readFileSync(first.dataFile('users.json'), 'utf8'), goodUsers);
    second = await startServer({ dir: first.dir });
    const login = await second.api('POST', '/api/login', { body: { username: 'keeper', password: 'keeper-pw' } });
    assert.equal(login.status, 200, 'with the files repaired, the account is still there');
  } finally {
    await first.stop();
    if (second) await second.close();
    else await first.close();
  }
});

test('re-registering a username does not revive sessions left over from an old account with that name', async () => {
  const first = await startServer();
  let second;
  try {
    const old = await first.register({ username: 'Ghost', password: 'old-password' });
    await flushSessions(first, 'ghost', 'old-password');
    await first.stop();
    // The account disappears from users.json (restored backup, manual edit, ...) but its session stays
    const users = readJson(first.dataFile('users.json'));
    delete users.ghost;
    fs.writeFileSync(first.dataFile('users.json'), JSON.stringify(users));

    second = await startServer({ dir: first.dir });
    assert.equal((await second.api('GET', '/api/me', { token: old.token })).status, 401);
    const fresh = await second.register({ username: 'ghost', password: 'new-password' });
    assert.equal((await second.api('GET', '/api/me', { token: old.token })).status, 401, 'old token must not log into the new account');
    assert.equal((await second.api('GET', '/api/me', { token: fresh.token })).status, 200);

    await flushSessions(second, 'ghost', 'new-password');
    const left = Object.values(readJson(second.dataFile('sessions.json'))).filter(s => s.username === 'ghost');
    assert.equal(left.length, 1, 'only the new session is left for "ghost"');
  } finally {
    await first.stop();
    if (second) await second.close();
    else await first.close();
  }
});
