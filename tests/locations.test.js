'use strict';

// Saved places: POST /api/me/locations, PUT .../order, PUT/DELETE .../:id

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, MSG } = require('./helpers');

const ID_RE = /^[a-f0-9]{12}$/;
const KOLDING = { name: 'Kolding', region: 'Syddanmark', country: 'Danmark', lat: 55.4904, lon: 9.4722 };

let srv;
before(async () => { srv = await startServer(); });
after(() => srv?.close());

const addRaw = (token, body) => srv.api('POST', '/api/me/locations', { token, body });
async function add(token, place = KOLDING) {
  const res = await addRaw(token, place);
  assert.equal(res.status, 201, res.text);
  return res.body.location;
}
const rename = (token, id, body) => srv.api('PUT', `/api/me/locations/${id}`, { token, body });
const remove = (token, id) => srv.api('DELETE', `/api/me/locations/${id}`, { token });
const reorder = (token, body) => srv.api('PUT', '/api/me/locations/order', { token, body });
const locationsOf = async token => (await srv.api('GET', '/api/me', { token })).body.user.locations;

describe('POST /api/me/locations', () => {
  test('201 { user, location } with a 12-hex id; label defaults to the name', async () => {
    const u = await srv.register();
    const res = await addRaw(u.token, KOLDING);
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body).sort(), ['location', 'user']);
    const loc = res.body.location;
    assert.deepEqual(Object.keys(loc), ['id', 'label', 'name', 'region', 'country', 'lat', 'lon']);
    assert.match(loc.id, ID_RE);
    assert.deepEqual(loc, { id: loc.id, label: 'Kolding', ...KOLDING });
    assert.deepEqual(res.body.user.locations, [loc]);
    assert.doesNotMatch(res.text, /salt|hash/);
    assert.deepEqual(await locationsOf(u.token), [loc]);
  });

  test('uses the given label; ids are unique per location', async () => {
    const u = await srv.register();
    const a = await add(u.token, { ...KOLDING, label: 'Hjem' });
    const b = await add(u.token, { ...KOLDING, label: 'Job' });
    assert.equal(a.label, 'Hjem');
    assert.equal(b.label, 'Job');
    assert.notEqual(a.id, b.id);
    assert.deepEqual((await locationsOf(u.token)).map(l => l.label), ['Hjem', 'Job']);
  });

  test('only name and finite lat/lon are required; region/country default to ""', async () => {
    const u = await srv.register();
    const loc = await add(u.token, { name: 'Nowhere', lat: 1, lon: 2 });
    assert.equal(loc.region, '');
    assert.equal(loc.country, '');
    assert.equal(loc.label, 'Nowhere');
  });

  test('a blank label falls back to the name', async () => {
    const u = await srv.register();
    for (const label of ['', '   ', null]) {
      assert.equal((await add(u.token, { ...KOLDING, label })).label, 'Kolding', JSON.stringify(label));
    }
  });

  test('trims and caps text fields: label 30, name 80, region 80, country 60', async () => {
    const u = await srv.register();
    const loc = await add(u.token, {
      label: '  ' + 'L'.repeat(40),
      name: '  ' + 'N'.repeat(100) + '  ',
      region: ' ' + 'R'.repeat(100),
      country: ' ' + 'C'.repeat(100),
      lat: 10, lon: 20
    });
    assert.equal(loc.label, 'L'.repeat(30));
    assert.equal(loc.name, 'N'.repeat(80));
    assert.equal(loc.region, 'R'.repeat(80));
    assert.equal(loc.country, 'C'.repeat(60));
  });

  test('the default label (the name) is capped at 30 too; the name itself keeps up to 80', async () => {
    // The label is shown in a narrow chip on the home screen. (Used to be: a long name became an uncapped label.)
    const u = await srv.register();
    const loc = await add(u.token, { name: 'N'.repeat(50), lat: 0.5, lon: 0.5 });
    assert.equal(loc.name, 'N'.repeat(50));
    assert.equal(loc.label, 'N'.repeat(30));
  });

  test('a label that is not a string falls back to the name; non-string region/country become ""', async () => {
    const u = await srv.register();
    for (const label of [{}, ['Hjem'], 42, true]) {
      const loc = await add(u.token, { ...KOLDING, label, region: ['x'], country: { a: 1 } });
      assert.equal(loc.label, 'Kolding', JSON.stringify(label));
      assert.equal(loc.region, '');
      assert.equal(loc.country, '');
    }
  });

  test('rounds lat/lon to 4 decimals', async () => {
    const u = await srv.register();
    const loc = await add(u.token, { name: 'Precise', lat: 55.123456, lon: -12.987654 });
    assert.equal(loc.lat, 55.1235);
    assert.equal(loc.lon, -12.9877);
  });

  test('accepts the exact bounds ±90 / ±180', async () => {
    const u = await srv.register();
    for (const [lat, lon] of [[90, 180], [-90, -180], [0, 0]]) {
      const loc = await add(u.token, { name: 'Edge', lat, lon });
      assert.equal(loc.lat, lat);
      assert.equal(loc.lon, lon);
    }
  });

  test('coordinates must be JSON numbers: numeric strings like "55.5" or "0x10" are refused', async () => {
    // Used to be coerced with Number(). The frontend always sends numbers (Open-Meteo results
    // and navigator.geolocation), so strings only come from hand-made requests.
    const u = await srv.register();
    for (const [lat, lon] of [['55.5', '12'], ['0x10', 10], [10, '1e1'], [' 5 ', 5]]) {
      const res = await addRaw(u.token, { name: 'Strings', lat, lon });
      assert.equal(res.status, 400, `lat=${JSON.stringify(lat)} lon=${JSON.stringify(lon)}`);
      assert.deepEqual(res.body, { error: MSG.badLocation });
    }
    assert.deepEqual(await locationsOf(u.token), []);
  });

  test('400 "Ugyldigt sted." for out-of-range, missing or non-numeric coordinates and missing names', async () => {
    const u = await srv.register();
    for (const body of [
      { ...KOLDING, lat: 90.0001 },
      { ...KOLDING, lat: -90.5 },
      { ...KOLDING, lon: 180.1 },
      { ...KOLDING, lon: -181 },
      { name: 'NoLat', lon: 10 },
      { name: 'NoLon', lat: 10 },
      { ...KOLDING, lat: 'abc' },
      { ...KOLDING, lon: {} },
      '{"name":"Inf","lat":1e400,"lon":1}',   // parses to Infinity
      { lat: 10, lon: 10 },
      { name: '', lat: 10, lon: 10 },
      { name: '    ', lat: 10, lon: 10 },
      {}
    ]) {
      const res = await addRaw(u.token, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(res.body, { error: MSG.badLocation });
    }
    assert.deepEqual(await locationsOf(u.token), []);
  });

  test('null, empty-string, boolean or array coordinates are rejected instead of becoming 0 (Null Island)', async () => {
    const u = await srv.register();
    for (const [lat, lon] of [[null, null], ['', ''], [true, false], [[], []]]) {
      const res = await addRaw(u.token, { name: 'Bad', lat, lon });
      assert.equal(res.status, 400, `lat=${JSON.stringify(lat)} lon=${JSON.stringify(lon)} -> ${res.status} ${res.text}`);
    }
  });

  test('a non-string name (object/array/number) is rejected instead of being stored as "[object Object]"', async () => {
    const u = await srv.register();
    for (const name of [{ x: 1 }, ['a', 'b'], 42]) {
      const res = await addRaw(u.token, { name, lat: 1, lon: 1 });
      assert.equal(res.status, 400, `${JSON.stringify(name)} -> ${res.status} ${res.text}`);
    }
    // String() throws on this one, which used to be a 500
    const res = await addRaw(u.token, '{"name":{"toString":1},"lat":1,"lon":1}');
    assert.equal(res.status, 400, res.text);
    assert.deepEqual(res.body, { error: MSG.badLocation });
    assert.deepEqual(await locationsOf(u.token), []);
  });

  test('at most MAX_LOCATIONS = 12; the 13th is refused, and deleting one frees a slot', async () => {
    const u = await srv.register();
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push((await add(u.token, { name: `Place ${i}`, lat: i, lon: i })).id);

    const res = await addRaw(u.token, { name: 'One too many', lat: 1, lon: 1 });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: MSG.tooManyLocations });
    assert.equal((await locationsOf(u.token)).length, 12);

    assert.equal((await remove(u.token, ids[0])).status, 200);
    assert.equal((await addRaw(u.token, { name: 'Fits again', lat: 1, lon: 1 })).status, 201);
  });

  test('400 for invalid JSON and 401 without a token', async () => {
    const u = await srv.register();
    const bad = await addRaw(u.token, '{"name":');
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, { error: MSG.invalidJson });

    const anon = await addRaw(undefined, KOLDING);
    assert.equal(anon.status, 401);
    assert.deepEqual(anon.body, { error: MSG.loginRequired });
  });
});

describe('PUT /api/me/locations/:id (rename)', () => {
  test('200 { user } with the new label; nothing else changes', async () => {
    const u = await srv.register();
    const loc = await add(u.token);
    const res = await rename(u.token, loc.id, { label: 'Hjem' });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['user']);
    assert.deepEqual(res.body.user.locations, [{ ...loc, label: 'Hjem' }]);
    assert.deepEqual(await locationsOf(u.token), [{ ...loc, label: 'Hjem' }]);
  });

  test('the label is trimmed and capped at 30', async () => {
    const u = await srv.register();
    const loc = await add(u.token);
    const res = await rename(u.token, loc.id, { label: '   ' + 'z'.repeat(45) });
    assert.equal(res.body.user.locations[0].label, 'z'.repeat(30));
  });

  test('renaming with an empty label uses the name, capped at 30', async () => {
    const u = await srv.register();
    const loc = await add(u.token, { name: 'Long'.repeat(10), label: 'Kort', lat: 1, lon: 1 });
    const res = await rename(u.token, loc.id, { label: '' });
    assert.equal(res.body.user.locations[0].label, 'Long'.repeat(10).slice(0, 30));
    const obj = await rename(u.token, loc.id, { label: { text: 'x' } });
    assert.equal(obj.body.user.locations[0].label, 'Long'.repeat(10).slice(0, 30), 'a non-string label is treated as empty');
  });

  test('an empty or missing label resets it to the name', async () => {
    const u = await srv.register();
    const loc = await add(u.token, { ...KOLDING, label: 'Job' });
    for (const body of [{ label: '' }, { label: '   ' }, {}, undefined]) {
      await rename(u.token, loc.id, { label: 'Temp' });
      const res = await rename(u.token, loc.id, body);
      assert.equal(res.status, 200);
      assert.equal(res.body.user.locations[0].label, 'Kolding', JSON.stringify(body));
    }
  });

  test('only touches the addressed location', async () => {
    const u = await srv.register();
    const a = await add(u.token, { ...KOLDING, label: 'A' });
    const b = await add(u.token, { ...KOLDING, label: 'B' });
    await rename(u.token, b.id, { label: 'B2' });
    assert.deepEqual((await locationsOf(u.token)).map(l => [l.id, l.label]), [[a.id, 'A'], [b.id, 'B2']]);
  });
});

describe('PUT /api/me/locations/order', () => {
  async function userWith(n) {
    const u = await srv.register();
    const ids = [];
    for (let i = 0; i < n; i++) ids.push((await add(u.token, { name: `P${i}`, lat: i, lon: i })).id);
    return { ...u, ids };
  }
  const orderOf = res => res.body.user.locations.map(l => l.id);

  test('applies the given order', async () => {
    const u = await userWith(4);
    const wanted = [u.ids[2], u.ids[0], u.ids[3], u.ids[1]];
    const res = await reorder(u.token, { ids: wanted });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['user']);
    assert.deepEqual(orderOf(res), wanted);
    assert.deepEqual((await locationsOf(u.token)).map(l => l.id), wanted);
  });

  test('locations left out of the list are kept at the end in their original order', async () => {
    const u = await userWith(4);
    const res = await reorder(u.token, { ids: [u.ids[3]] });
    assert.deepEqual(orderOf(res), [u.ids[3], u.ids[0], u.ids[1], u.ids[2]]);
  });

  test('unknown ids, duplicates and non-string ids are ignored; nothing is lost or duplicated', async () => {
    const u = await userWith(3);
    const res = await reorder(u.token, { ids: ['ffffffffffff', u.ids[2], 42, u.ids[2], null, u.ids[1], u.ids[2]] });
    assert.equal(res.status, 200);
    assert.deepEqual(orderOf(res), [u.ids[2], u.ids[1], u.ids[0]]);
  });

  test('an empty list keeps the current order', async () => {
    const u = await userWith(3);
    assert.deepEqual(orderOf(await reorder(u.token, { ids: [] })), u.ids);
  });

  test('another user\'s ids are ignored', async () => {
    const a = await userWith(2);
    const b = await userWith(2);
    const res = await reorder(b.token, { ids: [a.ids[0], b.ids[1], a.ids[1]] });
    assert.deepEqual(orderOf(res), [b.ids[1], b.ids[0]]);
    assert.deepEqual((await locationsOf(a.token)).map(l => l.id), a.ids);
  });

  test('400 "Rækkefølgen mangler." when ids is not an array', async () => {
    const u = await userWith(1);
    for (const body of [{}, { ids: 'abc' }, { ids: { 0: u.ids[0] } }, { ids: null }, [u.ids[0]], undefined]) {
      const res = await reorder(u.token, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(res.body, { error: MSG.orderMissing });
    }
  });

  test('401 without a token', async () => {
    const res = await reorder(undefined, { ids: [] });
    assert.equal(res.status, 401);
  });
});

describe('DELETE /api/me/locations/:id', () => {
  test('200 { user } without that location; a second delete is 404', async () => {
    const u = await srv.register();
    const a = await add(u.token, { ...KOLDING, label: 'A' });
    const b = await add(u.token, { ...KOLDING, label: 'B' });
    const res = await remove(u.token, a.id);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['user']);
    assert.deepEqual(res.body.user.locations, [b]);
    assert.deepEqual(await locationsOf(u.token), [b]);

    const again = await remove(u.token, a.id);
    assert.equal(again.status, 404);
    assert.deepEqual(again.body, { error: MSG.locationNotFound });
  });

  test('401 without a token', async () => {
    const res = await remove(undefined, 'aaaaaaaaaaaa');
    assert.equal(res.status, 401);
  });
});

describe('location ids: unknown, malformed and foreign', () => {
  test('404 "Stedet findes ikke." for a well-formed unknown id (PUT, DELETE and GET)', async () => {
    const u = await srv.register();
    await add(u.token);
    for (const method of ['PUT', 'DELETE', 'GET']) {
      const res = await srv.api(method, '/api/me/locations/0123456789ab', { token: u.token, body: method === 'PUT' ? { label: 'x' } : undefined });
      assert.equal(res.status, 404, method);
      assert.deepEqual(res.body, { error: MSG.locationNotFound }, method);
    }
  });

  test('404 "Ukendt API-adresse." for ids that are not 12 lowercase hex chars', async () => {
    const u = await srv.register();
    const loc = await add(u.token);
    for (const id of ['xyz', loc.id.toUpperCase(), loc.id + '0', loc.id.slice(1), `${loc.id}/extra`]) {
      const res = await rename(u.token, id, { label: 'x' });
      assert.equal(res.status, 404, id);
      assert.deepEqual(res.body, { error: MSG.unknownApi }, id);
    }
    assert.equal((await locationsOf(u.token))[0].label, loc.label);
  });

  test('an existing id with an unsupported method (GET/POST) is 404 "Ukendt API-adresse."', async () => {
    const u = await srv.register();
    const loc = await add(u.token);
    for (const method of ['GET', 'POST']) {
      const res = await srv.api(method, `/api/me/locations/${loc.id}`, { token: u.token });
      assert.equal(res.status, 404, method);
      assert.deepEqual(res.body, { error: MSG.unknownApi });
    }
  });

  test('GET /api/me/locations is not a route (locations come with GET /api/me)', async () => {
    const u = await srv.register();
    const res = await srv.api('GET', '/api/me/locations', { token: u.token });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: MSG.unknownApi });
  });

  test('another user\'s location id cannot be renamed or deleted (404) and stays unchanged', async () => {
    const owner = await srv.register();
    const intruder = await srv.register();
    await add(intruder.token, { name: 'Mine', lat: 1, lon: 1 });
    const loc = await add(owner.token, { ...KOLDING, label: 'Hjem' });

    const r = await rename(intruder.token, loc.id, { label: 'pwned' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: MSG.locationNotFound });
    const d = await remove(intruder.token, loc.id);
    assert.equal(d.status, 404);
    assert.deepEqual(d.body, { error: MSG.locationNotFound });

    assert.deepEqual(await locationsOf(owner.token), [loc]);
    assert.equal((await locationsOf(intruder.token)).length, 1);
  });
});
