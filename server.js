'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const util = require('util');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || 'localhost';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 dage
const MAX_SESSIONS = 10;                      // samtidige logins pr. bruger (de ældste smides ud)
const MAX_BODY = 100 * 1024;                  // 100 kB
const MAX_LOCATIONS = 12;
const MIN_PASSWORD = 8;

// Grænser mod gætteri af adgangskoder og masseoprettelse af profiler (se "Begrænsning af forsøg").
// Miljøvariablerne findes KUN til testene, som opretter hundredvis af brugere fra samme IP
// (127.0.0.1). Sæt dem ikke, når appen kører for rigtigt.
const LOGIN_MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS) || 5;  // forkerte logins pr. IP + brugernavn …
const LOGIN_WINDOW = 1000 * 60 * 15;                               // … pr. 15 min
const REGISTER_MAX = Number(process.env.REGISTER_MAX) || 20;       // nye profiler pr. IP …
const REGISTER_WINDOW = 1000 * 60 * 60;                            // … pr. time
const CLEANUP_INTERVAL = 1000 * 60 * 10;                           // oprydning hvert 10. minut

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

// Kun en fil, der ikke findes endnu, giver en tom database. Er filen ødelagt, stopper serveren
// hellere end at starte med en tom database: det næste gem ville ellers overskrive alle profiler.
function readJson(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return fallback;
    refuseToStart(file, `kan ikke læses (${err.code || err.message})`);
  }
  let data = null;
  try { data = JSON.parse(text); } catch { /* håndteres lige herunder */ }
  if (!data || typeof data !== 'object' || Array.isArray(data)) refuseToStart(file, 'er ødelagt (ikke et gyldigt JSON-objekt)');
  return data;
}

function refuseToStart(file, problem) {
  console.error(`\n  ${file} ${problem}.`);
  console.error('  Serveren starter ikke, så filen ikke bliver overskrevet. Ret filen, gendan en kopi,');
  console.error('  eller slet den, hvis dataene i den må gå tabt.\n');
  process.exit(1);
}

// Tabellerne er objekter uden prototype (Object.create(null)). I et almindeligt {} findes
// db.users['__proto__'] og db.users['constructor'] allerede (arvet fra Object), så de
// brugernavne var "optaget" og gav fejl ved login. Her er de bare almindelige nøgler.
const table = data => Object.assign(Object.create(null), data);

const db = {
  users: table(readJson(USERS_FILE, {})),       // nøgle: brugernavn med små bogstaver
  sessions: table(readJson(SESSIONS_FILE, {}))  // nøgle: sha256(token) -> { username, created }
};

// Der skrives højst én gang ad gangen til hver fil, og højst én skrivning venter bagefter.
// Gemmer flere requests, mens der skrives, deler de den ventende skrivning. Den laver først
// JSON'en, når den går i gang, så den gemmer de nyeste data (data er altid det samme objekt,
// db.users eller db.sessions), og der ligger ikke en kopi af hele filen i kø pr. request.
const writes = new Map();   // fil -> { running, queued }

function writeJson(file, data) {
  let w = writes.get(file);
  if (!w) writes.set(file, w = { running: Promise.resolve(), queued: null });
  if (!w.queued) {
    // .catch: en skrivning, der fejlede, må ikke forhindre den næste
    w.queued = w.running.catch(() => {}).then(() => {
      w.queued = null;
      w.running = writeFileSafely(file, JSON.stringify(data, null, 2));
      return w.running;
    });
    w.queued.catch(err => console.error('Kunne ikke gemme', file, err.message));
  }
  return w.queued;
}

// Skriver først til en .tmp-fil, som derefter omdøbes: så er filen aldrig halvt skrevet
async function writeFileSafely(file, json) {
  const tmp = file + '.tmp';
  const fh = await fsp.open(tmp, 'w', 0o600);   // 0600: kun serverens egen bruger kan læse filen
  try {
    await fh.writeFile(json);
    await fh.sync();   // data skal helt ned på disken før omdøbningen, ellers kan et strømsvigt give en tom fil
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

// Skrivninger, der er i gang eller venter (bruges ved nedlukning)
const pendingWrites = () => [...writes.values()].map(w => w.queued || w.running);
const saveUsers = () => writeJson(USERS_FILE, db.users);
const saveSessions = () => writeJson(SESSIONS_FILE, db.sessions);

// Sletter alle sessioner for et brugernavn
function dropSessions(key) {
  for (const [id, s] of Object.entries(db.sessions)) if (s.username === key) delete db.sessions[id];
}

/* ============================================================
   Adgangskoder — hashes med scrypt + salt (aldrig i klartekst)
   ============================================================ */
// scrypt er med vilje langsom (ca. 20 ms). Den asynkrone udgave regner i en baggrundstråd, så
// serveren kan svare andre imens. scryptSync fik alle andre requests til at vente i køen.
const scrypt = util.promisify(crypto.scrypt);

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: (await scrypt(password, salt, 64)).toString('hex') };
}
async function verifyPassword(password, salt, hash) {
  const a = await scrypt(password, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Bruges ved login, når brugernavnet ikke findes: koden tjekkes alligevel (og passer aldrig).
// Så tager "ukendt bruger" lige så lang tid som "forkert kode", og man kan ikke måle sig
// frem til, hvilke brugernavne der findes.
const NO_USER = { salt: '0'.repeat(32), hash: '0'.repeat(128) };

/* ============================================================
   Begrænsning af forsøg — mod gætteri af adgangskoder og spam
   ============================================================ */
// Huskes kun i hukommelsen (nøgle -> { count, start }) og glemmes ved genstart. Det er fint.
const loginAttempts = new Map();   // nøgle: "IP brugernavn"
const registrations = new Map();   // nøgle: IP

// Tæller ét forsøg og svarer true, hvis der nu er for mange i det aktuelle tidsvindue
function overLimit(map, key, max, windowMs) {
  const now = Date.now();
  let entry = map.get(key);
  if (!entry || now - entry.start > windowMs) map.set(key, entry = { count: 0, start: now });
  entry.count++;
  return entry.count > max;
}

// NB: bag en proxy (fx hos en hostingtjeneste) er det proxyens IP, og så deler alle brugerne grænsen
const clientIp = req => req.socket.remoteAddress || '';

/* ============================================================
   Profil og præferencer (skærm 06–08 og 10)
   ============================================================ */
const AGE_GROUPS = ['under12', '12-17', '18-29', '30-49', '50+'];
const COLD = ['fryser', 'normal', 'varm'];
const TRANSPORT = ['cykel', 'gaar', 'offentlig', 'bil'];

// Kun rigtige tekster og tal tæller. Number(x) gør null, "" og [] til 0, og String(x) gør
// ["a","b"] til "a,b" og {} til "[object Object]" (og { toString: 1 } får String() til at kaste).
const str = v => (typeof v === 'string' ? v : '');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

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

// Mærkatet vises i en smal "chip" på forsiden, så det er højst 30 tegn, også når bynavnet
// bruges i stedet for et tomt felt
function cleanLabel(value, fallback) {
  return (str(value).trim() || fallback).slice(0, 30);
}

function sanitizeLocation(input) {
  const src = input && typeof input === 'object' ? input : {};
  const lat = num(src.lat), lon = num(src.lon);   // front-enden sender altid rigtige tal
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = str(src.name).trim().slice(0, 80);
  if (!name) return null;
  return {
    id: crypto.randomBytes(6).toString('hex'),
    label: cleanLabel(src.label, name),   // fx "Hjem", "Campus", "Job"
    name,                                  // fx "Kolding"
    region: str(src.region).trim().slice(0, 80),
    country: str(src.country).trim().slice(0, 60),
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
    const tooLarge = () => httpError(413, 'Forespørgslen er for stor.');
    // Siger klienten på forhånd (Content-Length), at body'en er for stor, gemmes intet af den.
    // req.resume() læser den bare væk, så klienten kan nå at få vores 413-svar.
    if (Number(req.headers['content-length']) > MAX_BODY) { req.resume(); return reject(tooLarge()); }
    let size = 0;
    let chunks = [];
    req.on('data', chunk => {
      if (!chunks) return;   // allerede for stor: resten læses væk uden at blive gemt
      size += chunk.length;
      if (size > MAX_BODY) { chunks = null; reject(tooLarge()); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks) return;
      if (!chunks.length) return resolve({});
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(data && typeof data === 'object' ? data : {});
      } catch { reject(httpError(400, 'Ugyldig JSON.')); }
    });
    // Klienten lukkede forbindelsen midt i body'en (fx en lukket fane). Det er ikke en
    // serverfejl, så den skal ikke logges som en 500 med stack trace.
    req.on('error', () => reject(httpError(400, 'Forespørgslen blev afbrudt.')));
  });
}

// I sessions.json gemmes kun en SHA-256 af tokenet, aldrig selve tokenet. Den, der får fat i
// filen, kan altså ikke logge ind som andre: tokenet findes kun hos brugeren selv.
const tokenId = token => crypto.createHash('sha256').update(token).digest('hex');

async function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[tokenId(token)] = { username, created: Date.now() };
  // Højst MAX_SESSIONS pr. bruger, så filen ikke vokser for hvert login: de ældste ryger ud
  const own = Object.entries(db.sessions)
    .filter(([, s]) => s.username === username)
    .sort((a, b) => a[1].created - b[1].created);
  for (const [id] of own.slice(0, -MAX_SESSIONS)) delete db.sessions[id];
  // Gemmes, før tokenet sendes: ellers kan sessionen gå tabt, hvis serveren stopper lige efter
  await saveSessions();
  return token;
}

// Finder brugeren ud fra headeren "Authorization: Bearer <token>"
function authUser(req) {
  // Ordet "Bearer" må staves med store eller små bogstaver (det siger HTTP-standarden),
  // men selve tokenet skal være præcis 64 hex-tegn med små bogstaver, som vi laver dem.
  const m = /^(\S+)\s+([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m || m[1].toLowerCase() !== 'bearer') return null;
  const id = tokenId(m[2]);
  const s = db.sessions[id];
  if (!s) return null;
  if (Date.now() - s.created > SESSION_TTL) { delete db.sessions[id]; saveSessions(); return null; }
  const user = db.users[s.username];
  return user ? { user, sessionId: id, key: s.username } : null;
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
    const username = str(body.username).trim();
    const password = str(body.password);
    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) {
      throw httpError(400, 'Brugernavnet skal være 3–24 tegn (bogstaver, tal og . _ -).', 'username');
    }
    if (password.length < MIN_PASSWORD) {
      throw httpError(400, `Adgangskoden skal være mindst ${MIN_PASSWORD} tegn.`, 'password');
    }
    const key = username.toLowerCase();
    if (db.users[key]) throw httpError(409, 'Brugernavnet er optaget.', 'username');
    if (overLimit(registrations, clientIp(req), REGISTER_MAX, REGISTER_WINDOW)) {
      throw httpError(429, 'For mange nye profiler på kort tid. Prøv igen senere.');
    }

    const { salt, hash } = await hashPassword(password);
    // Mens koden blev hashet, kan en anden have nået at oprette samme navn: tjek igen
    if (db.users[key]) throw httpError(409, 'Brugernavnet er optaget.', 'username');
    const user = {
      username, salt, hash,
      createdAt: new Date().toISOString(),
      profile: sanitizeProfile(body.profile),
      locations: []
    };
    db.users[key] = user;
    // Gamle sessioner fra en tidligere profil med samme navn må ikke virke for den nye
    dropSessions(key);
    // Kunne profilen ikke gemmes, fjernes den igen. Ellers fandtes den kun indtil næste
    // genstart, og et nyt forsøg med samme navn fik "optaget".
    try { await saveUsers(); }
    catch (err) { delete db.users[key]; throw err; }
    return sendJson(res, 201, { token: await createSession(key), user: publicUser(user) });
  }

  if (method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req);
    const key = str(body.username).trim().toLowerCase();
    // Grænsen gælder pr. IP + brugernavn, så en angriber ikke kan låse den rigtige bruger ude.
    // Forsøget tælles, FØR koden tjekkes, så 100 samtidige gæt heller ikke slipper igennem.
    // (Brugernavnet kortes til 24 tegn — længere navne findes ikke, og nøglen skal være lille.)
    const limitKey = clientIp(req) + ' ' + key.slice(0, 24);
    if (overLimit(loginAttempts, limitKey, LOGIN_MAX_FAILS, LOGIN_WINDOW)) {
      throw httpError(429, 'For mange forsøg. Prøv igen om lidt.', 'password');
    }
    const user = db.users[key];
    const { salt, hash } = user || NO_USER;
    const ok = await verifyPassword(str(body.password), salt, hash);
    // Profilen kan være slettet, mens koden blev tjekket
    if (!user || !ok || db.users[key] !== user) {
      throw httpError(401, 'Forkert brugernavn eller adgangskode', 'password');
    }
    loginAttempts.delete(limitKey);   // rigtig kode: tælleren starter forfra
    return sendJson(res, 200, { token: await createSession(key), user: publicUser(user) });
  }

  // ---- Alt herunder kræver login ----
  const auth = authUser(req);
  if (!auth) throw httpError(401, 'Du skal være logget ind.');
  const { user } = auth;

  if (method === 'POST' && pathname === '/api/logout') {
    delete db.sessions[auth.sessionId];
    await saveSessions();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/me') {
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (method === 'DELETE' && pathname === '/api/me') {
    delete db.users[auth.key];
    dropSessions(auth.key);
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
   Oprydning — ved opstart og derefter hvert 10. minut
   ============================================================ */
function dropExpiredSessions() {
  let changed = false;
  for (const [id, s] of Object.entries(db.sessions)) {
    if (Date.now() - s.created > SESSION_TTL) { delete db.sessions[id]; changed = true; }
  }
  if (changed) saveSessions();
}
function forgetOld(map, windowMs) {
  const now = Date.now();
  for (const [key, entry] of map) if (now - entry.start > windowMs) map.delete(key);
}
function cleanUp() {
  dropExpiredSessions();
  forgetOld(loginAttempts, LOGIN_WINDOW);
  forgetOld(registrations, REGISTER_WINDOW);
}
cleanUp();
// .unref(): timeren alene holder ikke serveren i gang
setInterval(cleanUp, CLEANUP_INTERVAL).unref();

/* ============================================================
   Selve serveren
   ============================================================ */
const server = http.createServer(async (req, res) => {
  // En ødelagt adresse som "//[" får new URL() til at kaste en fejl. Den skal fanges her,
  // ellers vælter én enkelt forespørgsel hele serveren.
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return sendJson(res, 400, { error: 'Ugyldig adresse.' }); }

  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) {
      // Efter en for stor forespørgsel lukkes forbindelsen, så klienten ikke bliver ved med at sende
      if (status === 413) res.setHeader('Connection', 'close');
      sendJson(res, status, {
        error: status === 500 ? 'Der skete en fejl på serveren.' : err.message,
        field: err.field
      });
    }
  }
});

// Fx hvis serveren allerede kører i et andet vindue: en forståelig besked i stedet for en stack trace
server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`\n  Porten ${PORT} er optaget (EADDRINUSE). Kører Klädd allerede i et andet vindue?`);
  console.error(`  Stop den anden server, eller start med en anden port:  PORT=3001 npm start\n`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Klädd kører på  http://${HOST}:${PORT}`);
  console.log('  Stop serveren med  Ctrl + C\n');
});

// Ctrl + C (SIGINT) eller SIGTERM (fx fra en hostingtjeneste): tag ikke imod nye forbindelser,
// lad igangværende requests blive færdige, vent til alt er gemt, og stop så. Ellers kunne en
// ændring, der lige var ved at blive skrevet, gå tabt.
function shutdown() {
  console.log('\n  Stopper Klädd … gemmer først de sidste ændringer.');
  const finish = () => Promise.allSettled(pendingWrites()).then(() => process.exit(0));
  server.close(finish);
  setTimeout(finish, 2000).unref();   // en forbindelse, der hænger, venter vi højst 2 sekunder på
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
