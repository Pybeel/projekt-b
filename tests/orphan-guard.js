'use strict';

// Preloaded into every server under test (node --require ./orphan-guard.js server.js).
// If the test process that spawned the server dies without cleaning up (SIGKILL, runner
// timeout, ...), the server is re-parented and process.ppid changes: then exit too.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
}, 300).unref();
