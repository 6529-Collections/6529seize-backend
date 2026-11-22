import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { endProcess } from '@/rebuild/stack/child-process';
import { AdminTarget, MysqlAdmin } from '@/rebuild/stack/mysql-admin';

/** The installed MySQL 8.0 server on Windows; elsewhere `mysqld` on PATH. */
const WINDOWS_MYSQLD =
  'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqld.exe';
const READY_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 60_000;
const POLL_MS = 500;

export interface LocalMysqldOptions {
  /** The data directory and logs live under `<home>/mysql`. */
  readonly home: string;
  readonly port: number;
  readonly mysqldPath?: string;
  readonly log: (line: string) => void;
}

export interface LocalMysqld {
  readonly target: AdminTarget;
  readonly pid: number;
  readonly dataDir: string;
  stop(): Promise<void>;
}

function defaultMysqldPath(): string {
  if (process.env.REBUILD_MYSQLD) return process.env.REBUILD_MYSQLD;
  if (process.platform === 'win32' && fs.existsSync(WINDOWS_MYSQLD)) {
    return WINDOWS_MYSQLD;
  }
  return 'mysqld';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The server options, the same at initialize and at start. */
function serverArgs(dataDir: string, logDir: string): string[] {
  return [
    '--no-defaults',
    `--datadir=${dataDir}`,
    `--log-error=${path.join(logDir, 'mysqld.err')}`,
    '--default-authentication-plugin=mysql_native_password',
    '--character-set-server=utf8mb4',
    '--collation-server=utf8mb4_0900_ai_ci'
  ];
}

function startArgs(
  dataDir: string,
  logDir: string,
  port: number,
  initFile?: string
): string[] {
  return [
    ...serverArgs(dataDir, logDir),
    ...(initFile ? [`--init-file=${initFile}`] : []),
    `--port=${port}`,
    '--bind-address=127.0.0.1',
    '--mysqlx=OFF',
    `--pid-file=${path.join(logDir, 'mysqld.pid')}`,
    '--log-bin-trust-function-creators=1',
    '--skip-log-bin',
    '--default-time-zone=+00:00',
    '--max-allowed-packet=1G',
    '--innodb-buffer-pool-size=2G',
    '--innodb-flush-log-at-trx-commit=2',
    '--performance-schema=ON'
  ];
}

/** Whether anything accepts TCP connections on 127.0.0.1:port. */
export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitPortClosed(port: number): Promise<boolean> {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await portOpen(port))) return true;
    await sleep(POLL_MS);
  }
  return false;
}

function sameDirectory(a: string, b: string): boolean {
  const norm = (p: string) =>
    path
      .resolve(p)
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  return norm(a) === norm(b);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops a server a previous run left behind, after checking it is ours: by
 * the PID its run recorded in `<home>/mysql` (its root password died with
 * that run), or by SHUTDOWN when it still has the empty password of a fresh
 * data directory and serves this run's data directory.
 */
async function stopLeftover(
  target: AdminTarget,
  dataDir: string,
  pidFile: string,
  log: (line: string) => void
): Promise<void> {
  if (!(await portOpen(target.port))) return;
  let admin: MysqlAdmin;
  try {
    admin = await MysqlAdmin.connect({ ...target, password: '' });
  } catch (error) {
    const pid = fs.existsSync(pidFile)
      ? Number(fs.readFileSync(pidFile, 'utf8').trim())
      : NaN;
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
      log(
        `ending the server pid ${pid} a previous run left on port ${target.port}`
      );
      endProcess(pid);
      if (await waitPortClosed(target.port)) return;
    }
    throw new Error(
      `127.0.0.1:${target.port} is in use, and not by this run's server (${String(error)}); choose another port`
    );
  }
  const [row] = await admin.query<{ dir: string }>('SELECT @@datadir AS dir');
  if (!sameDirectory(row.dir, dataDir)) {
    admin.destroy();
    throw new Error(
      `Port ${target.port} serves ${row.dir}, not this run's ${dataDir}; refusing to touch it`
    );
  }
  log(`stopping the server a previous run left on port ${target.port}`);
  await admin.query('SHUTDOWN');
  admin.destroy();
  if (!(await waitPortClosed(target.port))) {
    throw new Error(`The leftover server on port ${target.port} did not stop`);
  }
}

function initialize(
  mysqld: string,
  dataDir: string,
  logDir: string,
  log: (line: string) => void
): void {
  log(`initializing a new data directory at ${dataDir}`);
  const result = spawnSync(
    mysqld,
    [...serverArgs(dataDir, logDir), '--initialize-insecure'],
    { windowsHide: true, encoding: 'utf8', timeout: READY_TIMEOUT_MS }
  );
  if (result.status !== 0) {
    throw new Error(
      `mysqld --initialize-insecure failed (${result.status}): ${result.stderr || result.error}; see ${path.join(logDir, 'mysqld.err')}`
    );
  }
}

async function waitReady(
  child: ChildProcess,
  target: AdminTarget,
  logDir: string
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `mysqld exited with ${child.exitCode}; see ${path.join(logDir, 'mysqld.err')}`
      );
    }
    if (await portOpen(target.port)) {
      const admin = await MysqlAdmin.connect(target).catch(() => null);
      if (admin) {
        admin.destroy();
        return;
      }
    }
    await sleep(POLL_MS);
  }
  throw new Error(`mysqld was not ready within ${READY_TIMEOUT_MS / 1000}s`);
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Starts a private mysqld on 127.0.0.1:`port` with its data under
 * `<home>/mysql`, initializing it the first time. `stop()` shuts down only
 * this process: by SHUTDOWN, then by its own PID if it hangs.
 */
export async function startLocalMysqld(
  options: LocalMysqldOptions
): Promise<LocalMysqld> {
  const mysqld = options.mysqldPath ?? defaultMysqldPath();
  const root = path.resolve(options.home, 'mysql');
  const dataDir = path.join(root, 'data');
  const logDir = path.join(root, 'log');
  fs.mkdirSync(logDir, { recursive: true });
  const pidFile = path.join(root, 'harness-mysqld.pid');
  // A new root password for every start, set by the server itself from a
  // file it reads at startup and deleted once it is up. Only this process
  // knows it; steps connect as their own users.
  const target: AdminTarget = {
    host: '127.0.0.1',
    port: options.port,
    user: 'root',
    password: randomBytes(24).toString('hex')
  };
  await stopLeftover(target, dataDir, pidFile, options.log);
  if (!fs.existsSync(dataDir) || fs.readdirSync(dataDir).length === 0) {
    initialize(mysqld, dataDir, logDir, options.log);
  }
  const initFile = path.join(
    root,
    `init-${randomBytes(8).toString('hex')}.sql`
  );
  fs.writeFileSync(
    initFile,
    `ALTER USER 'root'@'localhost' IDENTIFIED BY '${target.password}';\n`,
    { mode: 0o600 }
  );
  const out = fs.openSync(path.join(logDir, 'mysqld.out'), 'a');
  const child = spawn(
    mysqld,
    startArgs(dataDir, logDir, options.port, initFile),
    { windowsHide: true, stdio: ['ignore', out, out] }
  );
  fs.closeSync(out);
  if (child.pid === undefined) {
    fs.rmSync(initFile, { force: true });
    throw new Error(`Could not start ${mysqld}`);
  }
  const pid = child.pid;
  fs.writeFileSync(pidFile, `${pid}\n`);
  options.log(`mysqld started, pid ${pid}, port ${options.port}`);
  try {
    await waitReady(child, target, logDir);
  } catch (error) {
    if (child.exitCode === null) endProcess(pid);
    throw error;
  } finally {
    fs.rmSync(initFile, { force: true });
  }
  let stopped = false;
  return {
    target,
    pid,
    dataDir,
    async stop() {
      if (stopped) return;
      stopped = true;
      const admin = await MysqlAdmin.connect(target).catch(() => null);
      if (admin) {
        await admin.query('SHUTDOWN').catch(() => undefined);
        admin.destroy();
      }
      if (!(await waitExit(child, STOP_TIMEOUT_MS))) {
        options.log(`mysqld pid ${pid} did not stop; ending that pid`);
        endProcess(pid);
        await waitExit(child, STOP_TIMEOUT_MS);
      }
      options.log(`mysqld pid ${pid} stopped`);
    }
  };
}
