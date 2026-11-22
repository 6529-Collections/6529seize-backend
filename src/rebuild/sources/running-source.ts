import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { SourceInfo } from '@/rebuild/report/report';
import { UrlSource } from '@/rebuild/sources/source-spec';

/** A source the run serves or reaches, for the run's whole length. */
export interface RunningSource {
  readonly name: UrlSource;
  /** The base URL children use. */
  readonly url: string;
  readonly info: SourceInfo;
  /** Problems found while serving: unrecorded requests, bad files. */
  problems(): string[];
  stop(): Promise<void>;
}

/** What made a recording, from `<dir>/PROVENANCE.json`. */
export interface Provenance {
  /** For example `devnet <scenario>`, `anvil <state sha256>`, or `hand`. */
  readonly made_by: string;
  readonly note?: string;
  readonly recorded_at?: string;
}

export const PROVENANCE_FILE = 'PROVENANCE.json';

export function readProvenance(dir: string): Provenance | null {
  const file = path.join(dir, PROVENANCE_FILE);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Provenance;
}

export function writeProvenance(dir: string, provenance: Provenance): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, PROVENANCE_FILE),
    `${JSON.stringify(provenance, null, 2)}\n`
  );
}

/** A recording counts for the final proof unless it was written by hand. */
export function isProvisional(provenance: Provenance | null): boolean {
  return !provenance || provenance.made_by === 'hand';
}

/** Starts an HTTP server on 127.0.0.1 at a free port. */
export async function listenLoopback(
  server: http.Server
): Promise<{ url: string; port: number }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, port };
}

export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

export function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}
