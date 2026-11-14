import { writeFileSync } from 'node:fs';
import {
  parseStateAuditCommand,
  STATE_AUDIT_HELP,
  StateAuditRequest,
  StateAuditUsageError
} from './state-audit.options';
import type { StateAuditManifest } from './state-audit.manifest';

const EXIT_CODES: Record<StateAuditManifest['status'], number> = {
  clean: 0,
  differences_found: 3,
  inconclusive: 4
};

async function runInDbContext(
  request: StateAuditRequest
): Promise<StateAuditManifest> {
  // The shared environment/DB startup logs to stdout. Keep those diagnostics on
  // stderr so an operator can parse the CLI's one JSON result from stdout.
  const stdoutWrite = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr);
  try {
    const { doInDbContext } = await import('@/secrets');
    const { getEthereumRpcClient } =
      await import('@/ethereum-rpc/ethereum-rpc-client');
    const { getRpcChainId, Network } =
      await import('@/ethereum-rpc/ethereum-rpc-network');
    const { stateAuditDb } = await import('./state-audit.db');
    const { runStateAudit } = await import('./state-audit.service');
    return await doInDbContext(
      () =>
        runStateAudit(request, {
          rpc: getEthereumRpcClient(Network.ETH_MAINNET),
          db: stateAuditDb,
          chainId: getRpcChainId(Network.ETH_MAINNET)
        }),
      { syncEntities: false, skipRedis: true }
    );
  } finally {
    process.stdout.write = stdoutWrite;
  }
}

export async function main(
  args: string[] = process.argv.slice(2)
): Promise<number> {
  const command = parseStateAuditCommand(args);
  if (command.command === 'help') {
    process.stdout.write(STATE_AUDIT_HELP);
    return 0;
  }
  const manifest = await runInDbContext(command.request);
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  if (command.request.out) {
    writeFileSync(command.request.out, output, { encoding: 'utf8' });
    process.stderr.write(
      `${JSON.stringify({ status: manifest.status, out: command.request.out })}\n`
    );
  } else {
    process.stdout.write(output);
  }
  return EXIT_CODES[manifest.status];
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const usageError = error instanceof StateAuditUsageError;
      process.stderr.write(
        `${JSON.stringify({
          error: usageError ? error.message : 'State audit command failed.',
          code: usageError ? 'INVALID_ARGUMENTS' : 'EXECUTION_FAILED'
        })}\n`
      );
      process.exitCode = usageError ? 2 : 1;
    });
}
