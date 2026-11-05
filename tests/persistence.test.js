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

test('missing data files start an empty database; a corrupt users.json is silently treated as empty', async () => {
  // Current behaviour, pinned: readJson() falls back to {} on any parse error and the next
  // save overwrites the corrupt file, so every existing account is lost without a warning.
  const first = await startServer();
  let second;
  try {
    await first.stop();
    fs.writeFileSync(first.dataFile('users.json'), '{"halfwritten": {');
    second = await startServer({ dir: first.dir });
    const u = await second.register({ username: 'AfterCorrupt' });
    assert.equal((await second.api('GET', '/api/me', { token: u.token })).status, 200);
    assert.deepEqual(Object.keys(readJson(second.dataFile('users.json'))), ['aftercorrupt']);
  } finally {
    await first.stop();
    if (second) await second.close();
    else await first.close();
  }
});
