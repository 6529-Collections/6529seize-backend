import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isThisRunsServer,
  listeningInodes,
  netstatListener,
  ProcessInfo,
  ProcessProbe,
  stopLeftover,
  systemProcessProbe
} from '@/rebuild/stack/local-mysqld';

const DATA_DIR = path.join(os.tmpdir(), 'rebuild-home', 'mysql', 'data');
/** A loaded machine can take minutes to answer; the probes retry, bounded. */
const SYSTEM_TEST_MS = 1_000_000;
const LISTENER_WAIT_MS = 300_000;
/** Each look starts a process, so once a minute at most. */
const LISTENER_RETRY_MS = 60_000;

function probe(
  info: ProcessInfo | null,
  listener: number | null
): ProcessProbe {
  return {
    info: () => Promise.resolve(info),
    listener: () => Promise.resolve(listener)
  };
}

/** Asks until the answer is `want` or the time is up; the last answer. */
async function eventually<T>(ask: () => Promise<T>, want: T): Promise<T> {
  const deadline = Date.now() + LISTENER_WAIT_MS;
  let answer = await ask();
  while (answer !== want && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LISTENER_RETRY_MS));
    answer = await ask();
  }
  return answer;
}

describe('a leftover server', () => {
  it("is this run's only when mysqld, of this data directory, owns the port", async () => {
    const mysqld = {
      image: 'mysqld.exe',
      commandLine: `"C:\\mysql\\bin\\mysqld.exe" --no-defaults --datadir=${DATA_DIR} --port=3407`
    };
    await expect(
      isThisRunsServer(42, DATA_DIR, 3407, probe(mysqld, 42))
    ).resolves.toBe(true);
    // Another process, a reused PID, another data directory, another
    // listener, or nothing readable: never.
    await expect(
      isThisRunsServer(
        42,
        DATA_DIR,
        3407,
        probe({ image: 'node.exe', commandLine: mysqld.commandLine }, 42)
      )
    ).resolves.toBe(false);
    await expect(
      isThisRunsServer(
        42,
        DATA_DIR,
        3407,
        probe(
          {
            image: 'mysqld',
            commandLine: 'mysqld --datadir=/var/lib/mysql --port=3407'
          },
          42
        )
      )
    ).resolves.toBe(false);
    await expect(
      isThisRunsServer(42, DATA_DIR, 3407, probe(mysqld, 77))
    ).resolves.toBe(false);
    await expect(
      isThisRunsServer(42, DATA_DIR, 3407, probe(null, 42))
    ).resolves.toBe(false);
    await expect(
      isThisRunsServer(NaN, DATA_DIR, 3407, probe(mysqld, 42))
    ).resolves.toBe(false);
  });

  it('looks at a process only once it owns the port', async () => {
    const info = jest.fn(() => Promise.resolve(null));
    await expect(
      isThisRunsServer(42, DATA_DIR, 3407, {
        info,
        listener: () => Promise.resolve(77)
      })
    ).resolves.toBe(false);
    expect(info).not.toHaveBeenCalled();
  });

  it('reads the listening PID from netstat in any Windows language', () => {
    const netstat = [
      '',
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2380',
      '  TCP    127.0.0.1:3407         127.0.0.1:50120        ESTABLISHED     9000',
      '  TCP    127.0.0.1:13407        0.0.0.0:0              LISTENING       7000',
      '  TCP    127.0.0.1:3407         0.0.0.0:0              ABHÖREN         4242',
      ''
    ].join('\r\n');
    expect(netstatListener(netstat, 3407)).toBe(4242);
    expect(netstatListener(netstat, 135)).toBe(2380);
    expect(netstatListener(netstat, 9999)).toBeNull();
  });

  it('reads the listening socket from /proc/net/tcp', () => {
    // 0x0D4F is 3407; st 0A is LISTEN, 01 ESTABLISHED.
    const table = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0D4F 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0',
      '   1: 0100007F:0D4F 0100007F:C5C8 01 00000000:00000000 00:00000000 00000000  1000        0 223344 1 0000000000000000 20 4 30 10 -1',
      '   2: 0100007F:1D4F 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 334455 1 0000000000000000 100 0 0 10 0',
      ''
    ].join('\n');
    expect(listeningInodes(table, 3407)).toEqual(['123456']);
    expect(listeningInodes(table, 9999)).toEqual([]);
  });

  it(
    "reads a process's image and the port it listens on from the system",
    async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      try {
        const port = (server.address() as net.AddressInfo).port;
        await expect(
          eventually(() => systemProcessProbe.listener(port), process.pid)
        ).resolves.toBe(process.pid);
        expect((await systemProcessProbe.info(process.pid))?.image).toMatch(
          /^node(\.exe)?$/i
        );
        await expect(systemProcessProbe.info(-1)).resolves.toBeNull();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
    SYSTEM_TEST_MS
  );

  it(
    'never ends the process a stale pid file names when it is not the server',
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-stale-'));
      // A bystander under the stale PID, and a port that refuses MySQL.
      const bystander = spawn(
        process.execPath,
        ['-e', 'setTimeout(() => undefined, 1200000)'],
        { stdio: 'ignore', windowsHide: true }
      );
      const listener = net.createServer((socket) => socket.destroy());
      await new Promise<void>((resolve) =>
        listener.listen(0, '127.0.0.1', resolve)
      );
      const port = (listener.address() as net.AddressInfo).port;
      try {
        const pidFile = path.join(home, 'harness-mysqld.pid');
        fs.writeFileSync(pidFile, `${bystander.pid}\n`);
        await expect(
          stopLeftover(
            { host: '127.0.0.1', port, user: 'root', password: 'x' },
            path.join(home, 'data'),
            pidFile,
            () => undefined
          )
        ).rejects.toThrow('refusing to touch it');
        expect(bystander.exitCode).toBeNull();
        expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
      } finally {
        bystander.kill();
        if (bystander.exitCode === null) {
          await new Promise((resolve) => bystander.once('exit', resolve));
        }
        await new Promise((resolve) => listener.close(resolve));
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    SYSTEM_TEST_MS
  );
});
