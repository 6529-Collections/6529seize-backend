import { readFileSync, writeFileSync } from 'node:fs';
import {
  parseStateAuditApplyCommand,
  STATE_AUDIT_APPLY_HELP,
  StateAuditApplyRequest
} from './state-audit-apply.options';
import type {
  ApplyOutcome,
  StateAuditApplyReport
} from './state-audit-apply.service';
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

const APPLY_EXIT_CODES: Record<ApplyOutcome, number> = {
  planned: 0,
  applied: 0,
  already_applied: 0,
  rejected: 4,
  failed: 1
};

/**
 * The shared environment/DB startup logs to stdout. Keep those diagnostics on
 * stderr so an operator can parse the CLI's one JSON result from stdout.
 */
async function withStdoutOnStderr<T>(work: () => Promise<T>): Promise<T> {
  const stdoutWrite = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr);
  try {
    return await work();
  } finally {
    process.stdout.write = stdoutWrite;
  }
}

async function runInDbContext(
  request: StateAuditRequest
): Promise<StateAuditManifest> {
  return withStdoutOnStderr(async () => {
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
  });
}

function readManifestFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, { encoding: 'utf8' });
  } catch (error) {
    throw new StateAuditUsageError(
      `--manifest ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new StateAuditUsageError(`--manifest ${path} is not valid JSON.`);
  }
}

async function runApplyInDbContext(
  request: StateAuditApplyRequest
): Promise<StateAuditApplyReport> {
  const manifest = readManifestFile(request.manifestPath);
  return withStdoutOnStderr(async () => {
    const { doInDbContext } = await import('@/secrets');
    const { getEthereumRpcClient } =
      await import('@/ethereum-rpc/ethereum-rpc-client');
    const { getRpcChainId, Network } =
      await import('@/ethereum-rpc/ethereum-rpc-network');
    const { stateAuditApplyDb } = await import('./state-audit-apply.db');
    const { runStateAuditApply } = await import('./state-audit-apply.service');
    const { transferReconciliationDb } =
      await import('@/transactions/transfer-reconciliation.db');
    return await doInDbContext(
      () =>
        runStateAuditApply(manifest, request, {
          rpc: getEthereumRpcClient(Network.ETH_MAINNET),
          db: stateAuditApplyDb,
          reconciliation: transferReconciliationDb,
          chainId: getRpcChainId(Network.ETH_MAINNET)
        }),
      { syncEntities: false, skipRedis: true }
    );
  });
}

async function mainApply(args: string[]): Promise<number> {
  const command = parseStateAuditApplyCommand(args);
  if (command.command === 'apply-help') {
    process.stdout.write(STATE_AUDIT_APPLY_HELP);
    return 0;
  }
  const report = await runApplyInDbContext(command.request);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return APPLY_EXIT_CODES[report.outcome];
}

export async function main(
  args: string[] = process.argv.slice(2)
): Promise<number> {
  if (args[0] === 'apply') {
    return mainApply(args.slice(1));
  }
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
