import {
  DeliveryProbeDeps,
  DeliveryProbeOptions,
  ListenerMode,
  ProbeSocket,
  runDeliveryProbe
} from './delivery-probe';
import { Distribution } from './delivery-probe-stats';

const HELP = `ws:delivery-probe --api <https://api.staging.6529.io> --wave <wave-id>
  [--ws <wss://ws.staging.6529.io>] [--count 100] [--interval-ms 1000]
  [--listeners 1] [--listener-mode app|open-wave] [--settle-ms 5000] [--json]

Posts --count chat drops to --wave as the poster and times their delivery to
--listeners sockets, all on this machine's clock. Use a dedicated probe wave.

Environment:
  PROBE_POSTER_JWT     required; the posting identity's access token
  PROBE_LISTENER_JWT   optional; listener identity (anonymous when unset)
  PROBE_STAGING_AUTH   optional; staging gate value sent as x-6529-auth
`;

export function parseProbeArgs(
  args: readonly string[],
  env: Record<string, string | undefined>
): (DeliveryProbeOptions & { json: boolean }) | null {
  if (args.includes('--help')) return null;
  const values: Record<string, string> = {};
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    const value = args[index + 1];
    if (!arg.startsWith('--') || value === undefined || value.startsWith('--'))
      throw new Error(`Invalid argument ${arg}; use --help`);
    values[arg.slice(2)] = value;
    index++;
  }
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number
  ) => {
    const raw = values[name];
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
      throw new Error(`--${name} must be an integer from ${min} to ${max}`);
    return parsed;
  };
  const apiBase = values.api?.replace(/\/+$/, '');
  if (!apiBase?.startsWith('https://') && !apiBase?.startsWith('http://'))
    throw new Error('--api must be an http(s) base URL');
  const waveId = values.wave;
  if (!waveId) throw new Error('--wave is required');
  const posterJwt = env.PROBE_POSTER_JWT;
  if (!posterJwt) throw new Error('PROBE_POSTER_JWT is required');
  const listenerMode = (values['listener-mode'] ?? 'app') as ListenerMode;
  if (listenerMode !== 'app' && listenerMode !== 'open-wave')
    throw new Error('--listener-mode must be app or open-wave');
  const wsUrl = values.ws ?? deriveSocketUrl(apiBase);
  if (!wsUrl?.startsWith('wss://') && !wsUrl?.startsWith('ws://'))
    throw new Error('--ws must be a ws(s) URL');
  return {
    apiBase,
    wsUrl,
    waveId,
    count: integer('count', 100, 1, 1000),
    intervalMs: integer('interval-ms', 1000, 0, 60_000),
    listeners: integer('listeners', 1, 1, 50),
    listenerMode,
    settleMs: integer('settle-ms', 5000, 0, 60_000),
    connectTimeoutMs: 15_000,
    posterJwt,
    listenerJwt: env.PROBE_LISTENER_JWT || null,
    stagingAuth: env.PROBE_STAGING_AUTH || undefined,
    json
  };
}

/** Mirrors the frontend: https://api.<host> serves sockets at wss://ws.<host>. */
function deriveSocketUrl(apiBase: string): string {
  const derived = apiBase.replace(/^http(s?):\/\/api\./, 'ws$1://ws.');
  if (derived === apiBase)
    throw new Error('--ws is required when --api is not an api.<host> URL');
  return derived;
}

function formatDistribution(name: string, value: Distribution): string {
  const cell = (ms: number | null) => (ms === null ? '-' : `${ms}`);
  return `${name.padEnd(28)} n=${String(value.count).padEnd(5)} p50=${cell(
    value.p50
  ).padEnd(6)} p95=${cell(value.p95).padEnd(6)} p99=${cell(value.p99).padEnd(
    6
  )} max=${cell(value.max)}`;
}

export async function main(
  args = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env
): Promise<void> {
  const options = parseProbeArgs(args, env);
  if (!options) {
    process.stdout.write(HELP);
    return;
  }
  // Node 22+ provides browser-compatible WebSocket and fetch globals.
  const runtime = globalThis as unknown as {
    WebSocket?: new (url: string) => ProbeSocket;
    fetch?: DeliveryProbeDeps['fetch'];
  };
  const SocketConstructor = runtime.WebSocket;
  const runtimeFetch = runtime.fetch;
  if (!SocketConstructor || !runtimeFetch)
    throw new Error('ws:delivery-probe needs Node 22 or newer');
  const result = await runDeliveryProbe(options, {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    createSocket: (url) => new SocketConstructor(url),
    fetch: (url, init) => runtimeFetch(url, init)
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const { summary } = result;
  process.stdout.write(
    [
      `run ${result.runId}: ${summary.posts} posts (${summary.failedPosts} failed), ${summary.listeners} listener(s), mode ${options.listenerMode}`,
      formatDistribution('author POST response ms', summary.postResponseMs),
      formatDistribution('delivery ms (all)', summary.deliveryMs),
      formatDistribution(
        'delivery ms (last listener)',
        summary.lastListenerDeliveryMs
      ),
      formatDistribution('server receipt->sent_at ms', summary.serverFanoutMs),
      `delivered before POST returned: ${summary.deliveredBeforeResponse}`,
      `missing: ${summary.missing}  duplicates: ${summary.duplicates}`,
      ''
    ].join('\n')
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
