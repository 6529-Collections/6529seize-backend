import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { endProcess } from '@/rebuild/stack/child-process';
import { startAlchemyShim } from '@/rebuild/sources/alchemy-shim';
import { RunningSource } from '@/rebuild/sources/running-source';

const READY_TIMEOUT_MS = 60_000;

/** `REBUILD_ANVIL`, Foundry's default install, or `anvil` on PATH. */
function anvilPath(): string {
  if (process.env.REBUILD_ANVIL) return process.env.REBUILD_ANVIL;
  const name = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  const foundry = path.join(os.homedir(), '.foundry', 'bin', name);
  return fs.existsSync(foundry) ? foundry : 'anvil';
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
  });
}

async function chainId(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
        params: []
      })
    });
    const answer = (await response.json()) as { result?: string };
    return answer.result ?? null;
  } catch {
    return null;
  }
}

/**
 * The ethereum source as a local anvil (chain id 1), loaded from `state`
 * when given, behind the Alchemy shim. Children get the shim's URL for both
 * ETHEREUM_RPC_URL and ALCHEMY_BASE_URL.
 */
export async function startAnvil(options: {
  readonly state: string | null;
  readonly logFile: string;
}): Promise<RunningSource> {
  const port = await freePort();
  const args = [
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--chain-id',
    '1'
  ];
  let provenance = 'anvil, empty chain';
  if (options.state) {
    args.push('--load-state', options.state);
    const digest = createHash('sha256')
      .update(fs.readFileSync(options.state))
      .digest('hex');
    provenance = `anvil, state ${path.basename(options.state)} sha256 ${digest.slice(0, 16)}`;
  }
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
  const out = fs.openSync(options.logFile, 'a');
  const child = spawn(anvilPath(), args, {
    windowsHide: true,
    stdio: ['ignore', out, out]
  });
  fs.closeSync(out);
  const nodeUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await chainId(nodeUrl))) {
    if (child.exitCode !== null || Date.now() > deadline) {
      if (child.pid !== undefined) endProcess(child.pid);
      throw new Error(`anvil did not start; see ${options.logFile}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const shim = await startAlchemyShim(nodeUrl);
  return {
    name: 'ethereum',
    url: shim.url,
    info: { url: shim.url, mode: 'local', provenance, provisional: false },
    problems: () => shim.problems(),
    stop: async () => {
      await shim.stop();
      if (child.exitCode === null && child.pid !== undefined)
        endProcess(child.pid);
    }
  };
}
