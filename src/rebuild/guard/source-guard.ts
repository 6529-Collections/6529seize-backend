import * as fs from 'node:fs';
import * as net from 'node:net';

/** A connection the guard refused. */
export interface SourceViolation {
  readonly target: string;
  readonly pid: number;
  readonly at: string;
}

type ConnectTarget = { host: string; port: number } | { path: string };

const LOOPBACK_NAMES: Record<string, string> = {
  localhost: '127.0.0.1',
  '::1': '127.0.0.1',
  '::ffff:127.0.0.1': '127.0.0.1'
};

function normalizeHost(host: string): string {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return LOOPBACK_NAMES[bare] ?? bare;
}

/** Parses `host:port,host:port` into the set of allowed endpoints. */
export function parseAllowedEndpoints(spec: string | undefined): Set<string> {
  const allowed = new Set<string>();
  for (const entry of (spec ?? '').split(',')) {
    const trimmed = entry.trim();
    const colon = trimmed.lastIndexOf(':');
    if (colon <= 0) continue;
    const port = Number(trimmed.slice(colon + 1));
    if (Number.isInteger(port) && port > 0) {
      allowed.add(`${normalizeHost(trimmed.slice(0, colon))}:${port}`);
    }
  }
  return allowed;
}

/** Reads the target of a `net.Socket.prototype.connect` call. */
export function connectTarget(args: unknown[]): ConnectTarget | null {
  // net.connect passes its normalized arguments as one array.
  const list = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  const first = list[0];
  // Options objects from http agents have no prototype, so test types first.
  if (
    typeof first === 'number' ||
    (typeof first === 'string' && /^\d+$/.test(first))
  ) {
    const host = typeof list[1] === 'string' ? list[1] : 'localhost';
    return { host, port: Number(first) };
  }
  if (typeof first === 'string') return { path: first };
  if (first && typeof first === 'object') {
    const options = first as { host?: string; port?: number; path?: string };
    if (options.path) return { path: options.path };
    if (options.port !== undefined) {
      return { host: options.host ?? 'localhost', port: Number(options.port) };
    }
  }
  return null;
}

function describeTarget(target: ConnectTarget): string {
  return 'path' in target ? target.path : `${target.host}:${target.port}`;
}

export function isAllowedTarget(
  allowed: ReadonlySet<string>,
  target: ConnectTarget
): boolean {
  if ('path' in target) return false;
  return allowed.has(`${normalizeHost(target.host)}:${target.port}`);
}

/**
 * Refuses every socket except to the allowed endpoints. A refused socket
 * fails with an error, and the violation is reported even when the caller
 * swallows the error. Returns a function that removes the guard.
 */
export function installSourceGuard(options: {
  allowed: ReadonlySet<string>;
  onViolation: (violation: SourceViolation) => void;
}): () => void {
  const prototype = net.Socket.prototype as unknown as {
    connect: (...args: unknown[]) => net.Socket;
  };
  const original = prototype.connect;
  prototype.connect = function guardedConnect(
    this: net.Socket,
    ...args: unknown[]
  ) {
    // A call whose target can't be read is refused too: fail closed.
    const target = connectTarget(args);
    if (!target || !isAllowedTarget(options.allowed, target)) {
      const described = target
        ? describeTarget(target)
        : 'an unreadable target';
      options.onViolation({
        target: described,
        pid: process.pid,
        at: new Date().toISOString()
      });
      const error = new Error(
        `rebuild source guard: ${described} is not an allowed source`
      );
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return original.apply(this, args);
  };
  return () => {
    prototype.connect = original;
  };
}

/** Appends violations to a file, one JSON line each, for the run to report. */
export function violationFileWriter(
  file: string
): (violation: SourceViolation) => void {
  return (violation) => {
    fs.appendFileSync(file, `${JSON.stringify(violation)}\n`);
  };
}

export function readViolations(file: string): SourceViolation[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SourceViolation);
}
