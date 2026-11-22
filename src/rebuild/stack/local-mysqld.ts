import { ChildProcess, execFile, spawn, spawnSync } from 'node:child_process';
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

/** A process's image name and command line, or null when it can't be read. */
export interface ProcessInfo {
  readonly image: string;
  readonly commandLine: string;
}

/** How the run looks at other processes; tests replace it. */
export interface ProcessProbe {
  info(pid: number): Promise<ProcessInfo | null>;
  /** The PID listening on 127.0.0.1:`port`, or null when it can't be read. */
  listener(port: number): Promise<number | null>;
}

/** How long one system command may take, and how long a probe keeps trying. */
const PROBE_COMMAND_MS = 120_000;
const PROBE_DEADLINE_MS = 300_000;
const PROBE_RETRY_MS = 2_000;

/** A command's output, or why there is none. */
type Answer = { stdout: string } | 'timed out' | 'failed' | 'not run';

function run(
  command: string,
  args: string[],
  timeout: number
): Promise<Answer> {
  return new Promise((resolve) =>
    execFile(
      command,
      args,
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout,
        maxBuffer: 64 * 1024 * 1024
      },
      (error, stdout) => {
        if (!error) resolve({ stdout });
        else if (error.killed) resolve('timed out');
        // A string code is a command that could not run (ENOENT and the like).
        else resolve(typeof error.code === 'string' ? 'not run' : 'failed');
      }
    )
  );
}

/**
 * A command's output, or null when it gives no answer. One that runs out of
 * time, or with `retryFailures` one that fails, is tried again until
 * PROBE_DEADLINE_MS: a busy server can take minutes to start PowerShell or
 * answer WMI. A probe with no answer makes the run refuse to touch the
 * process, never end it.
 */
async function output(
  command: string,
  args: string[],
  retryFailures = false
): Promise<string | null> {
  const deadline = Date.now() + PROBE_DEADLINE_MS;
  for (;;) {
    const left = deadline - Date.now();
    const answer = await run(command, args, Math.min(PROBE_COMMAND_MS, left));
    if (typeof answer === 'object') return answer.stdout.trim();
    const again =
      answer === 'timed out' || (retryFailures && answer === 'failed');
    if (!again) return null;
    if (deadline - Date.now() <= PROBE_RETRY_MS) return null;
    await sleep(PROBE_RETRY_MS);
  }
}

function asPid(text: string | null | undefined): number | null {
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * The PID listening on `port` in `netstat -ano -p TCP` output. A listening
 * socket is the one with no remote end (port 0), which holds in every
 * Windows language, unlike the state column.
 */
export function netstatListener(text: string, port: number): number | null {
  for (const line of text.split(/\r?\n/)) {
    const [proto, local, remote, , pid] = line.trim().split(/\s+/);
    if (
      /^TCP/i.test(proto ?? '') &&
      local?.endsWith(`:${port}`) &&
      /:0$/.test(remote ?? '')
    ) {
      return asPid(pid);
    }
  }
  return null;
}

/** The socket inodes listening on `port` in /proc/net/tcp or tcp6. */
export function listeningInodes(table: string, port: number): string[] {
  const portHex = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  return table
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(
      // sl local_address rem_address st ... inode; st 0A is LISTEN.
      (fields) =>
        fields.length > 9 &&
        fields[1].endsWith(portHex) &&
        fields[3] === '0A' &&
        fields[9] !== '0'
    )
    .map((fields) => fields[9]);
}

/** The PID that owns the socket listening on `port`, from /proc alone. */
function procListener(port: number): number | null {
  const inodes = new Set<string>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      listeningInodes(fs.readFileSync(table, 'utf8'), port).forEach((inode) =>
        inodes.add(inode)
      );
    } catch {
      // No IPv6 table.
    }
  }
  if (!inodes.size) return null;
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[] = [];
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const socket = /^socket:\[(\d+)\]$/.exec(
          fs.readlinkSync(`/proc/${entry}/fd/${fd}`)
        );
        if (socket && inodes.has(socket[1])) return asPid(entry);
      } catch {
        // The process or descriptor is gone, or not ours to read.
      }
    }
  }
  return null;
}

/**
 * Reads processes through netstat and Win32_Process on Windows, /proc on
 * Linux, and lsof and ps elsewhere.
 */
export const systemProcessProbe: ProcessProbe = {
  async info(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (process.platform === 'win32') {
      // Only WMI has another process's command line on Windows.
      const out = await output(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object Name,CommandLine | ConvertTo-Json -Compress`
        ],
        true
      );
      if (!out) return null;
      try {
        const row = JSON.parse(out) as { Name?: string; CommandLine?: string };
        return row.Name
          ? { image: row.Name, commandLine: row.CommandLine ?? '' }
          : null;
      } catch {
        return null;
      }
    }
    if (process.platform === 'linux') {
      try {
        const args = fs
          .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
          .split('\0')
          .filter(Boolean);
        return args.length
          ? { image: path.basename(args[0]), commandLine: args.join(' ') }
          : null;
      } catch {
        return null;
      }
    }
    const image = await output('ps', ['-o', 'comm=', '-p', String(pid)]);
    const commandLine = await output('ps', [
      '-ww',
      '-o',
      'args=',
      '-p',
      String(pid)
    ]);
    return image && commandLine
      ? { image: path.basename(image), commandLine }
      : null;
  },
  async listener(port) {
    if (process.platform === 'linux') return procListener(port);
    if (process.platform === 'win32') {
      const out = await output('netstat', ['-ano', '-p', 'TCP'], true);
      return out ? netstatListener(out, port) : null;
    }
    const out = await output('lsof', [
      '-nP',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
      '-t'
    ]);
    return asPid(out?.split(/\s+/)[0]);
  }
};

/** The `--datadir=` value of a command line, unquoted. */
function dataDirOf(commandLine: string): string | null {
  const match = /--datadir=(?:"([^"]+)"|(\S+))/.exec(commandLine);
  return match ? (match[1] ?? match[2]) : null;
}

/**
 * Whether `pid` is this data directory's mysqld and the one listening on
 * `port`: its image is mysqld, its command line names this data directory,
 * and it owns the port. Anything less, and the run must not end it. The
 * port comes first: it is the cheap look, and most stale PIDs fail it.
 */
export async function isThisRunsServer(
  pid: number,
  dataDir: string,
  port: number,
  probe: ProcessProbe = systemProcessProbe
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if ((await probe.listener(port)) !== pid) return false;
  const info = await probe.info(pid);
  if (!info) return false;
  if (!/^mysqld(\.exe)?$/i.test(path.basename(info.image))) return false;
  const dir = dataDirOf(info.commandLine);
  return !!dir && sameDirectory(dir, dataDir);
}

/**
 * Stops a server a previous run left behind, after checking it is ours: by
 * the PID its run recorded in `<home>/mysql` (its root password died with
 * that run), or by SHUTDOWN when it still has the empty password of a fresh
 * data directory and serves this run's data directory.
 */
export async function stopLeftover(
  target: AdminTarget,
  dataDir: string,
  pidFile: string,
  log: (line: string) => void,
  probe: ProcessProbe = systemProcessProbe
): Promise<void> {
  if (!(await portOpen(target.port))) return;
  let admin: MysqlAdmin;
  try {
    admin = await MysqlAdmin.connect({ ...target, password: '' });
  } catch (error) {
    const pid = fs.existsSync(pidFile)
      ? Number(fs.readFileSync(pidFile, 'utf8').trim())
      : NaN;
    // Only a process proven to be this data directory's mysqld, listening
    // on this port, is ended; a PID Windows reused for anything else is not.
    if (await isThisRunsServer(pid, dataDir, target.port, probe)) {
      log(
        `ending the server pid ${pid} a previous run left on port ${target.port}`
      );
      endProcess(pid);
      if (await waitPortClosed(target.port)) {
        fs.rmSync(pidFile, { force: true });
        return;
      }
    }
    throw new Error(
      `127.0.0.1:${target.port} is in use, and not by a server of this run's data directory (${String(error)}); refusing to touch it, choose another port`
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
    fs.rmSync(pidFile, { force: true });
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
      // A pid file must never outlive its process: Windows reuses PIDs.
      fs.rmSync(pidFile, { force: true });
      options.log(`mysqld pid ${pid} stopped`);
    }
  };
}
