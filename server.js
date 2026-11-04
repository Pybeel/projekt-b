const http = require('http'); // til at lave en webserver
const fs = require('fs');     // til at læse filer
const path = require('path'); // til at arbejde med filstier

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  // Fjern query string (?...) og afkod %-tegn, f.eks. %2e%2e -> ..
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400);
    return res.end('Ugyldig forespørgsel');
  }

  // "/" betyder forsiden, altså index.html
  const file = path.resolve(PUBLIC_DIR, '.' + (urlPath === '/' ? '/index.html' : urlPath));

  // Sikkerhed: afvis alt, der peger uden for public-mappen (f.eks. "../server.js")
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Adgang nægtet');
  }

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