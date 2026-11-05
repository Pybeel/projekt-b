'use strict';

// PUT /api/me/profile — every field is sanitized; anything invalid is ignored (keeps the old value).

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, MSG } = require('./helpers');

const AGE_GROUPS = ['under12', '12-17', '18-29', '30-49', '50+'];
const COLD = ['fryser', 'normal', 'varm'];
const TRANSPORT = ['cykel', 'gaar', 'offentlig', 'bil'];

let srv;
before(async () => { srv = await startServer(); });
after(() => srv?.close());

/** PUT the profile, assert 200, return the profile from the response. */
async function put(token, body) {
  const res = await srv.api('PUT', '/api/me/profile', { token, body });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.body), ['user']);
  return res.body.user.profile;
}
const fresh = () => srv.register();

describe('PUT /api/me/profile', () => {
  test('401 without a token', async () => {
    const res = await srv.api('PUT', '/api/me/profile', { body: { onboarded: true } });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: MSG.loginRequired });
  });

  test('responds with the full public user and the change is visible in GET /api/me', async () => {
    const u = await fresh();
    const res = await srv.api('PUT', '/api/me/profile', { token: u.token, body: { coldSensitivity: 'varm' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { user: { ...u.user, profile: { ...u.user.profile, coldSensitivity: 'varm' } } });
    assert.doesNotMatch(res.text, /salt|hash/);
    const after = await srv.api('GET', '/api/me', { token: u.token });
    assert.deepEqual(after.body.user, res.body.user);
  });

  test('a partial update keeps every other field', async () => {
    const u = await fresh();
    await put(u.token, { ageGroup: '30-49', coldSensitivity: 'fryser', transport: 'bil', displayName: 'Kim', wardrobe: ['hue'], onboarded: true });
    const p = await put(u.token, { transport: 'cykel' });
    assert.deepEqual(p, { displayName: 'Kim', ageGroup: '30-49', coldSensitivity: 'fryser', transport: 'cykel', wardrobe: ['hue'], onboarded: true });
  });

  test('accepts every allowed enum value', async () => {
    const u = await fresh();
    for (const ageGroup of AGE_GROUPS) assert.equal((await put(u.token, { ageGroup })).ageGroup, ageGroup);
    for (const coldSensitivity of COLD) assert.equal((await put(u.token, { coldSensitivity })).coldSensitivity, coldSensitivity);
    for (const transport of TRANSPORT) assert.equal((await put(u.token, { transport })).transport, transport);
  });

  test('ignores values outside the enums (keeps the previous value)', async () => {
    const u = await fresh();
    await put(u.token, { ageGroup: '18-29', coldSensitivity: 'varm', transport: 'gaar' });
    for (const bad of ['bogus', 'UNDER12', ' 50+', 50, true, {}, ['cykel'], '']) {
      const p = await put(u.token, { ageGroup: bad, coldSensitivity: bad, transport: bad });
      assert.equal(p.ageGroup, '18-29', JSON.stringify(bad));
      assert.equal(p.coldSensitivity, 'varm', JSON.stringify(bad));
      assert.equal(p.transport, 'gaar', JSON.stringify(bad));
    }
  });

  test('ageGroup: null resets it to "not stated"', async () => {
    const u = await fresh();
    await put(u.token, { ageGroup: '12-17' });
    assert.equal((await put(u.token, { ageGroup: null })).ageGroup, null);
  });

  test('transport: null and coldSensitivity: null are ignored (only ageGroup can be reset to null)', async () => {
    // Current behaviour, pinned. Note the asymmetry with ageGroup even though transport also
    // defaults to null ("not stated"); the frontend never sends transport: null today.
    const u = await fresh();
    await put(u.token, { transport: 'offentlig', coldSensitivity: 'fryser' });
    const p = await put(u.token, { transport: null, coldSensitivity: null });
    assert.equal(p.transport, 'offentlig');
    assert.equal(p.coldSensitivity, 'fryser');
  });

  test('displayName is trimmed and capped at 40 characters', async () => {
    const u = await fresh();
    assert.equal((await put(u.token, { displayName: '   Maja  ' })).displayName, 'Maja');
    assert.equal((await put(u.token, { displayName: '  ' + 'x'.repeat(50) })).displayName, 'x'.repeat(40));
    assert.equal((await put(u.token, { displayName: 'æøå ÆØÅ' })).displayName, 'æøå ÆØÅ');
    assert.equal((await put(u.token, { displayName: '' })).displayName, '', 'an empty string clears it');
  });

  test('a non-string displayName is ignored', async () => {
    const u = await fresh();
    await put(u.token, { displayName: 'Keep' });
    for (const displayName of [123, null, true, ['x'], { a: 1 }]) {
      assert.equal((await put(u.token, { displayName })).displayName, 'Keep', JSON.stringify(displayName));
    }
  });

  test('wardrobe keeps only ids matching /^[a-z0-9-]{1,32}$/', async () => {
    const u = await fresh();
    const p = await put(u.token, {
      wardrobe: ['hue', 'regn-jakke', 'x'.repeat(32), 'y'.repeat(33), 'Hue', 'has space', '', 'æble', 'under_score', 42, null, {}, ['hue']]
    });
    assert.deepEqual(p.wardrobe, ['hue', 'regn-jakke', 'x'.repeat(32)]);
  });

  test('wardrobe is de-duplicated, keeping first-occurrence order', async () => {
    const u = await fresh();
    const p = await put(u.token, { wardrobe: ['b', 'a', 'b', 'c', 'a'] });
    assert.deepEqual(p.wardrobe, ['b', 'a', 'c']);
  });

  test('wardrobe is capped at 80 entries (after de-duplication)', async () => {
    const u = await fresh();
    const ids = Array.from({ length: 100 }, (_, i) => `item-${i}`);
    const p = await put(u.token, { wardrobe: [...ids.slice(0, 10), ...ids.slice(0, 10), ...ids] });
    assert.equal(p.wardrobe.length, 80);
    assert.deepEqual(p.wardrobe, ids.slice(0, 80));
  });

  test('wardrobe: [] is an empty list, wardrobe: null resets to the default wardrobe', async () => {
    const u = await fresh();
    assert.deepEqual((await put(u.token, { wardrobe: [] })).wardrobe, []);
    await put(u.token, { wardrobe: ['hue'] });
    assert.equal((await put(u.token, { wardrobe: null })).wardrobe, null);
  });

  test('a non-array, non-null wardrobe is ignored', async () => {
    const u = await fresh();
    await put(u.token, { wardrobe: ['hue'] });
    for (const wardrobe of ['hue', 1, true, { 0: 'hue' }]) {
      assert.deepEqual((await put(u.token, { wardrobe })).wardrobe, ['hue'], JSON.stringify(wardrobe));
    }
  });

  test('onboarded only accepts real booleans', async () => {
    const u = await fresh();
    assert.equal((await put(u.token, { onboarded: true })).onboarded, true);
    for (const onboarded of ['false', 0, null, 'true', 1]) {
      assert.equal((await put(u.token, { onboarded })).onboarded, true, JSON.stringify(onboarded));
    }
    assert.equal((await put(u.token, { onboarded: false })).onboarded, false);
  });

  test('unknown fields are dropped and cannot touch username/createdAt/locations', async () => {
    const u = await fresh();
    const res = await srv.api('PUT', '/api/me/profile', {
      token: u.token,
      body: { isAdmin: true, username: 'hacker', createdAt: '2000-01-01', locations: [{ id: 'x' }], profile: { onboarded: true } }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.user, u.user);
  });

  test('a JSON body that is not an object (null, string, number, array) changes nothing', async () => {
    const u = await fresh();
    for (const raw of ['null', '"str"', '42', '[1,2]', '']) {
      const res = await srv.api('PUT', '/api/me/profile', { token: u.token, body: raw });
      assert.equal(res.status, 200, raw);
      assert.deepEqual(res.body.user, u.user, raw);
    }
  });

  test('400 for invalid JSON', async () => {
    const u = await fresh();
    const res = await srv.api('PUT', '/api/me/profile', { token: u.token, body: '{"onboarded": tru' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: MSG.invalidJson });
  });
});
