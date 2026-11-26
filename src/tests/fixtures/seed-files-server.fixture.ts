import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

/** The request's last path segment, decoded, if it is a plain file name. */
function nameOf(url: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(url.split('/').pop() ?? '');
  } catch {
    return null;
  }
  return /^[A-Za-z0-9]+$/.test(id) ? id : null;
}

/**
 * A rebuild run's files source for tests: the files in one directory over
 * loopback, each at /<name> (the last path segment; /ipfs/<cid> and
 * /ar/<id> both work). Only a plain file name is served, resolved inside
 * the directory; anything else answers 404 without touching the disk.
 */
export async function serveSeedFiles(dir: string): Promise<http.Server> {
  const root = path.resolve(dir);
  const notFound = (res: http.ServerResponse) => {
    res.statusCode = 404;
    res.end();
  };
  const server = http.createServer((req, res) => {
    const id = nameOf(req.url ?? '');
    if (id === null) {
      notFound(res);
      return;
    }
    const file = path.resolve(root, id);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      notFound(res);
      return;
    }
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}
