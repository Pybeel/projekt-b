'use strict';

// data/users.json + data/sessions.json: what is written, and what survives a restart.
// Every test runs its own server(s) in its own temp dir.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * logout() is the one call that awaits the sessions.json write (register/login fire and forget),
 * and writes are queued in order, so after this the file reflects every session created so far.
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

    const sessions = readJson(srv.dataFile('sessions.json'));
    assert.deepEqual(Object.keys(sessions), [u.token], 'only the register session is left (the flush session logged out)');
    assert.equal(sessions[u.token].username, 'diskuser');
    assert.equal(typeof sessions[u.token].created, 'number');
    assert.ok(Math.abs(Date.now() - sessions[u.token].created) < 60_000);

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
    sessions[u.token].created = Date.now() - 31 * DAY;
    sessions[young].created = Date.now() - 29 * DAY;
    fs.writeFileSync(file, JSON.stringify(sessions));

    second = await startServer({ dir: first.dir });
    assert.equal((await second.api('GET', '/api/me', { token: u.token })).status, 401, '31-day-old session expired');
    assert.equal((await second.api('GET', '/api/me', { token: young })).status, 200, '29-day-old session still valid');
    assert.equal((await second.api('POST', '/api/login', { body: { username: 'ttl', password: 'ttl-password' } })).status, 200);
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
