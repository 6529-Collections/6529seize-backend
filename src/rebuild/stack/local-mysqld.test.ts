import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isThisRunsServer,
  ProcessProbe,
  stopLeftover,
  systemProcessProbe
} from '@/rebuild/stack/local-mysqld';

const DATA_DIR = path.join(os.tmpdir(), 'rebuild-home', 'mysql', 'data');

function probe(
  info: ReturnType<ProcessProbe['info']>,
  listener: number | null
): ProcessProbe {
  return { info: () => info, listener: () => listener };
}

describe('a leftover server', () => {
  it("is this run's only when mysqld, of this data directory, owns the port", () => {
    const mysqld = {
      image: 'mysqld.exe',
      commandLine: `"C:\\mysql\\bin\\mysqld.exe" --no-defaults --datadir=${DATA_DIR} --port=3407`
    };
    expect(isThisRunsServer(42, DATA_DIR, 3407, probe(mysqld, 42))).toBe(true);
    // Another process, a reused PID, another data directory, another
    // listener, or nothing readable: never.
    expect(
      isThisRunsServer(
        42,
        DATA_DIR,
        3407,
        probe({ image: 'node.exe', commandLine: mysqld.commandLine }, 42)
      )
    ).toBe(false);
    expect(
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
    ).toBe(false);
    expect(isThisRunsServer(42, DATA_DIR, 3407, probe(mysqld, 77))).toBe(false);
    expect(isThisRunsServer(42, DATA_DIR, 3407, probe(null, 42))).toBe(false);
    expect(isThisRunsServer(NaN, DATA_DIR, 3407, probe(mysqld, 42))).toBe(
      false
    );
  });

  it("reads a process's image and the port it listens on from the system", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    try {
      const port = (server.address() as net.AddressInfo).port;
      expect(systemProcessProbe.info(process.pid)?.image).toMatch(
        /^node(\.exe)?$/i
      );
      expect(systemProcessProbe.listener(port)).toBe(process.pid);
      expect(systemProcessProbe.info(-1)).toBeNull();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 60_000);

  it('never ends the process a stale pid file names when it is not the server', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-stale-'));
    // A bystander under the stale PID, and a port that refuses MySQL.
    const bystander = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => undefined, 120000)'],
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
      await new Promise((resolve) => listener.close(resolve));
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
