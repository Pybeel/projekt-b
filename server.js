const http = require('http'); // til at lave en webserver
const fs = require('fs');     // til at læse filer
const path = require('path'); // til at arbejde med filstier

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

const server = http.createServer((req, res) => {
  // "/" betyder forsiden, altså index.html
  const file = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Ikke fundet');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Kører på http://localhost:${PORT}`));