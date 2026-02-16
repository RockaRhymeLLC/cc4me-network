/**
 * CC4Me Network Relay — identity, presence, and contacts server.
 *
 * The relay knows WHO is on the network but never sees WHAT they say.
 * Zero message content is ever stored or routed.
 */

import { createServer } from 'node:http';

const PORT = parseInt(process.env.PORT || '8080', 10);

const server = createServer((req, res) => {
  // TODO: Wire up route handlers from ./routes/
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '2.0' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''))) {
  server.listen(PORT, () => {
    console.log(`CC4Me Relay listening on :${PORT}`);
  });
}

export { server };
