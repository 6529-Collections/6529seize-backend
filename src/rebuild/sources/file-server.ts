import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  closeServer,
  isProvisional,
  listenLoopback,
  readProvenance,
  RunningSource
} from '@/rebuild/sources/running-source';

/** `<dir>/files.json`: each file's id and the SHA-256 of its bytes. */
export const FILE_INDEX = 'files.json';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** `/ipfs/<cid>`, `/ar/<id>`, `/docs/<cid>` or `/<id>`, optionally with a path suffix. */
const ROUTE = /^\/(?:(?:ipfs|ar|docs)\/)?([A-Za-z0-9_-]{1,128})(?:[/?].*)?$/;

export function fileIdOf(urlPath: string): string | null {
  const match = ROUTE.exec(urlPath);
  return match ? match[1] : null;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Checks every file against `files.json`: a file listed with another hash,
 * or listed and missing, is a problem. Files not listed are served but
 * reported, so the index stays complete.
 */
export function checkFiles(dir: string): {
  readonly files: Map<string, Buffer>;
  readonly problems: string[];
} {
  const files = new Map<string, Buffer>();
  const problems: string[] = [];
  const indexFile = path.join(dir, FILE_INDEX);
  const index: Record<string, string> = fs.existsSync(indexFile)
    ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    : {};
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const full = path.join(dir, name);
    if (!ID.test(name) || !fs.statSync(full).isFile()) continue;
    const bytes = fs.readFileSync(full);
    files.set(name, bytes);
    if (!(name in index)) problems.push(`${name} is not in ${FILE_INDEX}`);
    else if (index[name] !== sha256(bytes)) {
      problems.push(`${name} does not match its hash in ${FILE_INDEX}`);
    }
  }
  for (const name of Object.keys(index)) {
    if (!files.has(name))
      problems.push(`${name} is in ${FILE_INDEX} but missing`);
  }
  return { files, problems };
}

/**
 * A file the run's seeds wrote into `seedDir` and listed in its own
 * files.json, read and checked against its hash when it is asked for.
 */
function seedFile(
  seedDir: string,
  id: string,
  problems: string[]
): Buffer | undefined {
  const note = (problem: string) => {
    if (!problems.includes(problem)) problems.push(problem);
  };
  const indexFile = path.join(seedDir, FILE_INDEX);
  if (!fs.existsSync(indexFile)) return undefined;
  let index: Record<string, unknown>;
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    note(`the seeds' ${FILE_INDEX} is not valid JSON`);
    return undefined;
  }
  const file = path.join(seedDir, id);
  if (
    !Object.prototype.hasOwnProperty.call(index, id) ||
    !fs.existsSync(file)
  ) {
    return undefined;
  }
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== index[id]) {
    note(`seed file ${id} does not match its hash in ${FILE_INDEX}`);
    return undefined;
  }
  return bytes;
}

/**
 * Serves a directory of content-addressed files on loopback, and, when
 * given, the files the run's seeds write into `seedDir`.
 */
export async function startFileServer(
  dir: string,
  seedDir?: string
): Promise<RunningSource> {
  const { files, problems } = checkFiles(dir);
  const missing: string[] = [];
  const provenance = readProvenance(dir);
  const server = http.createServer((request, response) => {
    const id = fileIdOf(request.url ?? '');
    const bytes = id
      ? (files.get(id) ??
        (seedDir ? seedFile(seedDir, id, problems) : undefined))
      : undefined;
    if (!bytes) {
      missing.push(request.url ?? '');
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(bytes);
  });
  const { url } = await listenLoopback(server);
  return {
    name: 'files',
    url,
    info: {
      url,
      mode: 'local',
      provenance: provenance?.made_by ?? `${files.size} files in ${dir}`,
      provisional: isProvisional(provenance)
    },
    problems: () => [
      ...problems.map((p) => `files: ${p}`),
      ...(missing.length
        ? [
            `files: ${missing.length} requests for files not in the directory, first ${missing.slice(0, 5).join(', ')}`
          ]
        : [])
    ],
    stop: () => closeServer(server)
  };
}
