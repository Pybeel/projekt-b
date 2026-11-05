'use strict';

/**
 * Test harness for server.js.
 *
 * server.js stores its data in path.join(__dirname, 'data'), so every server under test
 * runs from a fresh copy of server.js + public/ inside a temp dir (never the repo).
 * Each start picks a free port; stop() kills the process, close() also removes the dir.
 * Any child process still alive when the test process exits is SIGKILLed, and its temp
 * dir removed, so a failing or crashing test file never leaves servers behind; if the test
 * process is killed outright, orphan-guard.js (preloaded into the server) makes it exit.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO_DIR = path.join(__dirname, '..');
const HOST = '127.0.0.1';
const READY_LINE = 'Klädd kører på';
const START_TIMEOUT = 10_000;
const ORPHAN_GUARD = path.join(__dirname, 'orphan-guard.js');

const liveChildren = new Set();
const tempDirs = new Set();

function cleanupSync() {
  for (const child of liveChildren) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
process.on('exit', cleanupSync);
// Signals skip 'exit' handlers by default (Ctrl+C, the runner killing a file on timeout).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => {
    cleanupSync();
    process.exit(128 + os.constants.signals[sig]);
  });
}

/** A fresh temp dir holding a copy of server.js and public/. */
function makeAppDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaedd-test-'));
  tempDirs.add(dir);
  fs.copyFileSync(path.join(REPO_DIR, 'server.js'), path.join(dir, 'server.js'));
  fs.cpSync(path.join(REPO_DIR, 'public'), path.join(dir, 'public'), { recursive: true });
  return dir;
}

/** Ask the OS for a free port by listening on port 0 and closing again. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function spawnServer(dir, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', ORPHAN_GUARD, 'server.js'], {
      cwd: dir,
      env: { ...process.env, PORT: String(port), HOST },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    liveChildren.add(child);
    const logs = { stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(reject, new Error(`server did not start within ${START_TIMEOUT} ms\n${logs.stdout}${logs.stderr}`));
    }, START_TIMEOUT);

    child.stdout.on('data', chunk => {
      logs.stdout += chunk;
      if (logs.stdout.includes(READY_LINE)) settle(resolve, { child, logs });
    });
    child.stderr.on('data', chunk => { logs.stderr += chunk; });
    child.on('exit', (code, signal) => {
      liveChildren.delete(child);
      settle(reject, Object.assign(
        new Error(`server exited before it was ready (code ${code}, signal ${signal})\n${logs.stderr}`),
        { logs, code, signal }
      ));
    });
  });
}

/**
 * Start a server. Pass { dir } to reuse an existing app dir (restart / persistence tests),
 * { port } to force a port (no retry if it is taken).
 * If the process exits before it is ready, the promise rejects with { logs, code, signal }.
 * Returns a handle: { dir, port, base, child, logs, api(), register(), raw(), isAlive(), stop(), close() }.
 */
async function startServer({ dir = makeAppDir(), port: fixedPort } = {}) {
  let started;
  for (let attempt = 1; !started; attempt++) {
    const port = fixedPort ?? await freePort();
    try {
      started = { port, ...(await spawnServer(dir, port)) };
    } catch (err) {
      // Someone grabbed the port between freePort() and listen(): try another one.
      if (fixedPort === undefined && attempt < 3 && /EADDRINUSE/.test(err.logs?.stderr || '')) continue;
      throw err;
    }
  }
  const { port, child, logs } = started;
  const base = `http://${HOST}:${port}`;
  let userCounter = 0;

  const handle = {
    dir,
    port,
    base,
    child,
    logs,
    dataFile: name => path.join(dir, 'data', name),

    /** JSON API call. body: object (JSON-encoded) or string (sent verbatim). */
    async api(method, urlPath, { token, body, headers = {} } = {}) {
      const h = { ...headers };
      let payload;
      if (body !== undefined) {
        payload = typeof body === 'string' ? body : JSON.stringify(body);
        if (!('Content-Type' in h)) h['Content-Type'] = 'application/json';
      }
      if (token) h.Authorization = `Bearer ${token}`;
      const res = await fetch(base + urlPath, { method, headers: h, body: payload });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      return { status: res.status, headers: res.headers, text, body: json };
    },

    /** Register a user with a unique name (unless given) and assert 201. */
    async register({ username, password = 'correct-horse', ...extra } = {}) {
      userCounter++;
      username ??= `user_${userCounter}_${Math.random().toString(16).slice(2, 6)}`;
      const res = await handle.api('POST', '/api/register', { body: { username, password, ...extra } });
      if (res.status !== 201) {
        throw new Error(`register(${username}) expected 201, got ${res.status}: ${res.text}`);
      }
      return { username, password, token: res.body.token, user: res.body.user };
    },

    /** Raw HTTP over a TCP socket (for request targets fetch would normalise). */
    raw(request, opts) {
      return rawRequest(port, request, opts);
    },

    /** True if the process is running and answers GET /. */
    async isAlive() {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      try {
        const res = await fetch(base + '/', { signal: AbortSignal.timeout(2000) });
        await res.arrayBuffer();
        return res.status === 200;
      } catch {
        return false;
      }
    },

    /** Resolves with the exit code (or signal) once the process has exited, or null after `ms`. */
    waitForExit(ms = 2000) {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode ?? child.signalCode);
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), ms);
        child.once('exit', (code, signal) => { clearTimeout(timer); resolve(code ?? signal); });
      });
    },

    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    },

    async close() {
      await handle.stop();
      fs.rmSync(dir, { recursive: true, force: true });
      tempDirs.delete(dir);
    }
  };
  return handle;
}

/** Run fn(server) against a throwaway server that is always cleaned up. */
async function withServer(fn) {
  const srv = await startServer();
  try { return await fn(srv); }
  finally { await srv.close(); }
}

/**
 * Send raw bytes, collect everything until the server closes the connection.
 * Never rejects: socket errors (e.g. ECONNRESET) are reported in `.error`.
 * Resolves { raw, status, headers, body, error }; status is null if no response came back.
 */
function rawRequest(port, request, { timeout = 3000 } = {}) {
  const parts = Array.isArray(request) ? request : [request];
  return new Promise(resolve => {
    const chunks = [];
    let error = null;
    const sock = net.connect(port, HOST);
    const timer = setTimeout(() => {
      error ??= new Error('raw request timed out');
      sock.destroy();
    }, timeout);
    sock.on('connect', () => { for (const p of parts) sock.write(p); });
    sock.on('data', c => chunks.push(c));
    sock.on('error', e => { error ??= e; });
    sock.on('close', () => {
      clearTimeout(timer);
      resolve({ ...parseRawResponse(Buffer.concat(chunks).toString('utf8')), error });
    });
  });
}

function parseRawResponse(raw) {
  const sep = raw.indexOf('\r\n\r\n');
  if (!raw.startsWith('HTTP/') || sep === -1) return { raw, status: null, headers: {}, body: '' };
  const [statusLine, ...headerLines] = raw.slice(0, sep).split('\r\n');
  const headers = {};
  for (const line of headerLines) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let body = raw.slice(sep + 4);
  if (/chunked/i.test(headers['transfer-encoding'] || '')) body = dechunk(body);
  return { raw, status: Number(statusLine.split(' ')[1]), headers, body };
}

function dechunk(text) {
  let out = '';
  let rest = Buffer.from(text, 'utf8');
  for (;;) {
    const lineEnd = rest.indexOf('\r\n');
    if (lineEnd === -1) break;
    const size = parseInt(rest.subarray(0, lineEnd).toString(), 16);
    if (!size) break;
    out += rest.subarray(lineEnd + 2, lineEnd + 2 + size).toString('utf8');
    rest = rest.subarray(lineEnd + 2 + size + 2);
  }
  return out;
}

/** "GET /x HTTP/1.1" request text with Host + Connection: close. */
function rawGet(target, method = 'GET') {
  return `${method} ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`;
}

module.exports = { startServer, withServer, rawRequest, rawGet, REPO_DIR };

/** Error messages exactly as server.js sends them (the frontend shows them to users). */
const MSG = {
  username: 'Brugernavnet skal være 3–24 tegn (bogstaver, tal og . _ -).',
  password: 'Adgangskoden skal være mindst 8 tegn.',
  taken: 'Brugernavnet er optaget.',
  badLogin: 'Forkert brugernavn eller adgangskode',
  loginRequired: 'Du skal være logget ind.',
  unknownApi: 'Ukendt API-adresse.',
  invalidJson: 'Ugyldig JSON.',
  tooLarge: 'Forespørgslen er for stor.',
  serverError: 'Der skete en fejl på serveren.',
  badLocation: 'Ugyldigt sted.',
  tooManyLocations: 'Du kan højst gemme 12 steder.',
  orderMissing: 'Rækkefølgen mangler.',
  locationNotFound: 'Stedet findes ikke.',
  badAddress: 'Ugyldig adresse.'
};

module.exports.MSG = MSG;
