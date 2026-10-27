const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const PREVIEW_FILE = path.join(__dirname, 'preview.html');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/preview.html') {
    fs.readFile(PREVIEW_FILE, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading preview: ' + err.message);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Fallback 404 or redirect to root
  res.writeHead(302, { 'Location': '/' });
  res.end();
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`✨ Brooke's Closet — Client Interactive Preview Server`);
  console.log(`   Running at: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
