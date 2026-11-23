// 6529 run rebuild:relay-capture -- [options]. See docs/rebuild-check.md.
import * as path from 'node:path';
import { captureRelay } from '@/rebuild/sources/crp-relay-capture';

const USAGE = `Usage: rebuild:relay-capture -- --relay <ws url> --dir <dir> --net <name> --made-by <text> [options]
  --relay <url>             the relay to record (CRP v1 over WebSocket)
  --dir <dir>               the recording to write; replay:<dir> serves it
  --net <name>              the network HELLO names (the run's relay net)
  --made-by <text>          PROVENANCE.json's made_by: how it was really made
  --devnet-scenario <name>  the devnet scenario whose events these are
  --harness-wallet <0x..>   AUTH as this wallet (the harness relay only)
  --quiet-ms <n>            how long SUB's replay may go quiet (default 2000)`;

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!name.startsWith('--') || value === undefined) {
      throw new Error(USAGE);
    }
    out[name.slice(2)] = value;
  }
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  for (const required of ['relay', 'dir', 'net', 'made-by']) {
    if (!a[required]) throw new Error(`--${required} is missing\n${USAGE}`);
  }
  const result = await captureRelay({
    url: a.relay,
    dir: path.resolve(a.dir),
    net: a.net,
    madeBy: a['made-by'],
    devnetScenario: a['devnet-scenario'],
    harnessWallet: a['harness-wallet'],
    quietMs: a['quiet-ms'] ? Number(a['quiet-ms']) : undefined
  });
  process.stdout.write(
    `recorded ${result.events} events in ${result.logs.length} logs (${result.logs.join(', ')}) and ${result.payloads} payloads into ${path.resolve(a.dir)}\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
