// A board's API from a test in the same process, one fresh connection per request (no keep-alive). fetch() keeps the
// connection open, and a test that runs the fix loop between two calls (seconds of git and captures on a slow Windows
// runner) lets the board close it after its 5 s keep-alive while the client still holds it: the next request then goes
// out on a socket the server is closing ("fetch failed"). A browser retries such a request; a test should not need to.
import { request } from 'node:http';

// → { status, json, type }
export function boardRequest(origin, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, origin);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { 'x-nunchi-token': token, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length), origin } : {}) };
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: data ? 'POST' : 'GET', headers, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, json, type: res.headers['content-type'] || null });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}
