import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ChildResult {
  readonly label: string;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly logFile: string;
}

export interface ChildSpec {
  readonly label: string;
  readonly repoRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logFile: string;
  readonly timeoutMs: number;
  /** A repo-relative TypeScript entry run under ts-node with the guard. */
  readonly entry?: string;
  readonly args?: readonly string[];
  /** Or any command; Node commands get the guard through NODE_OPTIONS. */
  readonly command?: readonly string[];
  /** For a command that loads the guard itself (the API bundle). */
  readonly guardLoaded?: boolean;
  /** The working directory; the repo root unless given. */
  readonly cwd?: string;
}

const GUARD_PRELOAD = path.join(
  'src',
  'rebuild',
  'guard',
  'source-guard.preload.ts'
);

/** Node arguments that load TypeScript, path aliases and the source guard. */
function nodePreloadArgs(repoRoot: string): string[] {
  return [
    '-r',
    'ts-node/register',
    '-r',
    'tsconfig-paths/register',
    '-r',
    path.join(repoRoot, GUARD_PRELOAD)
  ];
}

/** NODE_OPTIONS that put the guard into any Node process a command starts. */
function guardNodeOptions(repoRoot: string): string {
  const resolve = (request: string) =>
    require.resolve(request, { paths: [repoRoot] });
  return [resolve('ts-node/register'), path.join(repoRoot, GUARD_PRELOAD)]
    .map((file) => `--require "${file}"`)
    .join(' ');
}

/** Windows' own taskkill, by its full path rather than from PATH. */
function taskkill(): string {
  return path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'taskkill.exe'
  );
}

/** Ends a process this run started, with its children on Windows. */
export function endProcess(pid: number): void {
  if (process.platform === 'win32') {
    // taskkill can hang on a busy server; it gets a minute, then the
    // caller's fallback ends the process itself.
    spawnSync(taskkill(), ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 60_000
    });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

export interface StartedChild {
  readonly pid: number | null;
  readonly exited: Promise<number | null>;
  /** Ends the process by its PID and waits for it. */
  stop(): Promise<number | null>;
}

/** How long stop() waits for a child to exit after each attempt to end it. */
const STOP_WAIT_MS = 30_000;

/**
 * Starts a child: a TypeScript entry under ts-node with the source guard, or
 * a command. Output goes to `logFile`.
 */
export function startChild(spec: ChildSpec): StartedChild {
  fs.mkdirSync(path.dirname(spec.logFile), { recursive: true });
  const out = fs.openSync(spec.logFile, 'a');
  const [file, args, env] = spec.entry
    ? [
        process.execPath,
        [
          ...nodePreloadArgs(spec.repoRoot),
          path.join(spec.repoRoot, spec.entry),
          ...(spec.args ?? [])
        ],
        spec.env
      ]
    : [
        spec.command![0],
        [...spec.command!.slice(1), ...(spec.args ?? [])],
        spec.guardLoaded
          ? spec.env
          : { ...spec.env, NODE_OPTIONS: guardNodeOptions(spec.repoRoot) }
      ];
  const child = spawn(file, args, {
    cwd: spec.cwd ?? spec.repoRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', out, out]
  });
  fs.closeSync(out);
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('exit', (code) => resolve(code));
  });
  return {
    pid: child.pid ?? null,
    exited,
    async stop() {
      // Whether the child exits within `ms`; the timer never outlives it.
      const ended = async (ms: number) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            exited.then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), ms);
            })
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      if (child.exitCode === null && child.pid !== undefined) {
        endProcess(child.pid);
        // If the tree kill didn't take, end the process itself, so a run
        // never waits on a child that won't exit.
        if (!(await ended(STOP_WAIT_MS))) child.kill('SIGKILL');
        if (!(await ended(STOP_WAIT_MS))) return null;
      }
      return exited;
    }
  };
}

/** Runs one child to completion; one past its time limit is ended by PID. */
export async function runChild(spec: ChildSpec): Promise<ChildResult> {
  const started = Date.now();
  const child = startChild(spec);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void child.stop();
  }, spec.timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timer);
  return {
    label: spec.label,
    pid: child.pid,
    exitCode,
    timedOut,
    durationMs: Date.now() - started,
    logFile: spec.logFile
  };
}
