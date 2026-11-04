'use strict';
/**
 * Klädd — back-end
 * --------------------------------------------------------------
 * En lille Node.js-server UDEN eksterne pakker (kun indbyggede moduler):
 *   - serverer front-enden (HTML, CSS, JS) fra mappen /public
 *   - tilbyder et REST-API til registrering, login og brugerpræferencer
 *   - gemmer brugere og sessioner i JSON-filer i mappen /data
 *
 * Start:  npm start   (eller: node server.js)
 * Åbn:    http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || 'localhost';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 dage
const MAX_BODY = 100 * 1024;                  // 100 kB
const MAX_LOCATIONS = 12;
const MIN_PASSWORD = 8;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/* ============================================================
   Datalag — JSON-filer på disken
   ============================================================ */
fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

const db = {
  users: readJson(USERS_FILE, {}),       // nøgle: brugernavn med små bogstaver
  sessions: readJson(SESSIONS_FILE, {})  // nøgle: token -> { username, created }
};

// Skrivninger lægges i kø pr. fil, så to samtidige requests ikke ødelægger filen.
// Der skrives først til en .tmp-fil, som derefter omdøbes (atomisk skrivning).
const queues = new Map();
function writeJson(file, data) {
  const json = JSON.stringify(data, null, 2);
  const prev = queues.get(file) || Promise.resolve();
  const next = prev.then(async () => {
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, json);
    await fsp.rename(tmp, file);
  });
  queues.set(file, next.catch(err => console.error('Kunne ikke gemme', file, err)));
  return next;
}
const saveUsers = () => writeJson(USERS_FILE, db.users);
const saveSessions = () => writeJson(SESSIONS_FILE, db.sessions);

// Ryd udløbne sessioner ved opstart
for (const [token, s] of Object.entries(db.sessions)) {
  if (Date.now() - s.created > SESSION_TTL) delete db.sessions[token];
}

/* ============================================================
   Adgangskoder — hashes med scrypt + salt (aldrig i klartekst)
   ============================================================ */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, salt, hash) {
  const a = crypto.scryptSync(password, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ============================================================
   Profil og præferencer (skærm 06–08 og 10)
   ============================================================ */
const AGE_GROUPS = ['under12', '12-17', '18-29', '30-49', '50+'];
const COLD = ['fryser', 'normal', 'varm'];
const TRANSPORT = ['cykel', 'gaar', 'offentlig', 'bil'];

function defaultProfile() {
  return {
    displayName: '',
    ageGroup: null,          // null = ikke oplyst (behandles som voksen)
    coldSensitivity: 'normal',
    transport: null,         // null = ikke oplyst
    wardrobe: null,          // null = standardgarderobe ud fra alder; ellers en liste af tøj-id'er
    onboarded: false         // true når de 3 spørgsmål efter oprettelse er besvaret eller sprunget over
  };
}

function sanitizeProfile(input, current = defaultProfile()) {
  const src = input && typeof input === 'object' ? input : {};
  const p = { ...defaultProfile(), ...current };
  if (typeof src.displayName === 'string') p.displayName = src.displayName.trim().slice(0, 40);
  if (src.ageGroup === null || AGE_GROUPS.includes(src.ageGroup)) p.ageGroup = src.ageGroup;
  if (COLD.includes(src.coldSensitivity)) p.coldSensitivity = src.coldSensitivity;
  if (TRANSPORT.includes(src.transport)) p.transport = src.transport;
  if (typeof src.onboarded === 'boolean') p.onboarded = src.onboarded;
  if (src.wardrobe === null) p.wardrobe = null;
  else if (Array.isArray(src.wardrobe)) {
    p.wardrobe = [...new Set(
      src.wardrobe.filter(id => typeof id === 'string' && /^[a-z0-9-]{1,32}$/.test(id))
    )].slice(0, 80);
  }
  return p;
}

function cleanLabel(value, fallback) {
  const label = String(value || '').trim().slice(0, 30);
  return label || fallback;
}

function sanitizeLocation(input) {
  const src = input && typeof input === 'object' ? input : {};
  const lat = Number(src.lat), lon = Number(src.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = String(src.name || '').trim().slice(0, 80);
  if (!name) return null;
  return {
    id: crypto.randomBytes(6).toString('hex'),
    label: cleanLabel(src.label, name),   // fx "Hjem", "Campus", "Job"
    name,                                  // fx "Kolding"
    region: String(src.region || '').trim().slice(0, 80),
    country: String(src.country || '').trim().slice(0, 60),
    lat: Math.round(lat * 1e4) / 1e4,
    lon: Math.round(lon * 1e4) / 1e4
  };
}

// Det der sendes til browseren — aldrig hash eller salt
function publicUser(u) {
  return { username: u.username, createdAt: u.createdAt, profile: u.profile, locations: u.locations };
}

/* ============================================================
   HTTP-hjælpere
   ============================================================ */
// field = hvilket formularfelt fejlen hører til, så front-enden kan vise den ved feltet
const httpError = (status, message, field) => Object.assign(new Error(message), { status, field });

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(httpError(413, 'Forespørgslen er for stor.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(data && typeof data === 'object' ? data : {});
      } catch { reject(httpError(400, 'Ugyldig JSON.')); }
    });
    req.on('error', reject);
  });
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { username, created: Date.now() };
  saveSessions();
  return token;
}

// Finder brugeren ud fra headeren "Authorization: Bearer <token>"
function authUser(req) {
  const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = db.sessions[m[1]];
  if (!s) return null;
  if (Date.now() - s.created > SESSION_TTL) { delete db.sessions[m[1]]; saveSessions(); return null; }
  const user = db.users[s.username];
  return user ? { user, token: m[1], key: s.username } : null;
}

/* ============================================================
   API-ruter
   ------------------------------------------------------------
   POST   /api/register               opret profil  -> { token, user }
   POST   /api/login                  log ind       -> { token, user }
   POST   /api/logout                 log ud
   GET    /api/me                     hent bruger + præferencer
   PUT    /api/me/profile             gem alder, kuldefølsomhed, transport, garderobe
   DELETE /api/me                     slet profil og alle data
   POST   /api/me/locations           gem sted (med navn, fx "Hjem")
   PUT    /api/me/locations/order     gem rækkefølgen af steder
   PUT    /api/me/locations/:id       omdøb sted
   DELETE /api/me/locations/:id       fjern sted
   ============================================================ */
async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (method === 'POST' && pathname === '/api/register') {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) {
      throw httpError(400, 'Brugernavnet skal være 3–24 tegn (bogstaver, tal og . _ -).', 'username');
    }
    if (password.length < MIN_PASSWORD) {
      throw httpError(400, `Adgangskoden skal være mindst ${MIN_PASSWORD} tegn.`, 'password');
    }
    const key = username.toLowerCase();
    if (db.users[key]) throw httpError(409, 'Brugernavnet er optaget.', 'username');

    const { salt, hash } = hashPassword(password);
    const user = {
      username, salt, hash,
      createdAt: new Date().toISOString(),
      profile: sanitizeProfile(body.profile),
      locations: []
    };
    db.users[key] = user;
    await saveUsers();
    return sendJson(res, 201, { token: createSession(key), user: publicUser(user) });
  }

  if (method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req);
    const key = String(body.username || '').trim().toLowerCase();
    const user = db.users[key];
    if (!user || !verifyPassword(String(body.password || ''), user.salt, user.hash)) {
      throw httpError(401, 'Forkert brugernavn eller adgangskode', 'password');
    }
    return sendJson(res, 200, { token: createSession(key), user: publicUser(user) });
  }

  // ---- Alt herunder kræver login ----
  const auth = authUser(req);
  if (!auth) throw httpError(401, 'Du skal være logget ind.');
  const { user } = auth;

  if (method === 'POST' && pathname === '/api/logout') {
    delete db.sessions[auth.token];
    await saveSessions();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/me') {
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (method === 'DELETE' && pathname === '/api/me') {
    delete db.users[auth.key];
    for (const [token, s] of Object.entries(db.sessions)) if (s.username === auth.key) delete db.sessions[token];
    await Promise.all([saveUsers(), saveSessions()]);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'PUT' && pathname === '/api/me/profile') {
    user.profile = sanitizeProfile(await readBody(req), user.profile);
    await saveUsers();
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (method === 'POST' && pathname === '/api/me/locations') {
    const loc = sanitizeLocation(await readBody(req));
    if (!loc) throw httpError(400, 'Ugyldigt sted.');
    if (user.locations.length >= MAX_LOCATIONS) throw httpError(400, `Du kan højst gemme ${MAX_LOCATIONS} steder.`);
    user.locations.push(loc);
    await saveUsers();
    return sendJson(res, 201, { user: publicUser(user), location: loc });
  }

  if (method === 'PUT' && pathname === '/api/me/locations/order') {
    const { ids } = await readBody(req);
    if (!Array.isArray(ids)) throw httpError(400, 'Rækkefølgen mangler.');
    const byId = new Map(user.locations.map(l => [l.id, l]));
    const ordered = ids.map(id => byId.get(id)).filter(Boolean);
    // Steder, der ikke var med i listen, beholdes til sidst
    const rest = user.locations.filter(l => !ids.includes(l.id));
    user.locations = [...new Set([...ordered, ...rest])];
    await saveUsers();
    return sendJson(res, 200, { user: publicUser(user) });
  }

  const locMatch = /^\/api\/me\/locations\/([a-f0-9]{12})$/.exec(pathname);
  if (locMatch) {
    const loc = user.locations.find(l => l.id === locMatch[1]);
    if (!loc) throw httpError(404, 'Stedet findes ikke.');

    if (method === 'PUT') {
      const body = await readBody(req);
      loc.label = cleanLabel(body.label, loc.name);
      await saveUsers();
      return sendJson(res, 200, { user: publicUser(user) });
    }
    if (method === 'DELETE') {
      user.locations = user.locations.filter(l => l !== loc);
      await saveUsers();
      return sendJson(res, 200, { user: publicUser(user) });
    }
  }

  throw httpError(404, 'Ukendt API-adresse.');
}

/* ============================================================
   Statiske filer fra /public
   ============================================================ */
async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.join(PUBLIC_DIR, rel);
  // Beskyt mod "../"-tricks, så man ikke kan læse filer uden for /public
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }

  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Ikke fundet');
  }
}

/* ============================================================
   Selve serveren
   ============================================================ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) {
      sendJson(res, status, {
        error: status === 500 ? 'Der skete en fejl på serveren.' : err.message,
        field: err.field
      });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Klädd kører på  http://localhost:${PORT}`);
  console.log('  Stop serveren med  Ctrl + C\n');
});
