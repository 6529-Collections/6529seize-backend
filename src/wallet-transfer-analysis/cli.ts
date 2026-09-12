import {
  parseWalletTransferAnalysisCommand,
  WALLET_TRANSFER_ANALYSIS_HELP,
  WalletTransferAnalysisCommand,
  WalletTransferAnalysisUsageError
} from './cli-options';
import type { WalletTransferAnalysisService } from './wallet-transfer-analysis.service';
import { WalletTransferAnalysisError } from './types';

async function executeCommand(
  command: Exclude<WalletTransferAnalysisCommand, { command: 'help' }>,
  service: WalletTransferAnalysisService
): Promise<unknown> {
  switch (command.command) {
    case 'status':
      return service.status();
    case 'explain':
      return service.explain(command);
    case 'update':
      return service.update(command);
    case 'rebuild':
      return service.rebuild(command);
    case 'report':
      return service.report(command);
  }
}

async function runInDbContext(
  command: Exclude<WalletTransferAnalysisCommand, { command: 'help' }>
): Promise<unknown> {
  // The shared environment/DB startup logs to stdout. Keep those diagnostics on
  // stderr so an operator can parse the CLI's one JSON result from stdout.
  const stdoutWrite = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr);
  try {
    const { doInDbContext } = await import('@/secrets');
    const { walletTransferAnalysisService } =
      await import('./wallet-transfer-analysis.service');
    return await doInDbContext(
      () => executeCommand(command, walletTransferAnalysisService),
      { syncEntities: false, skipRedis: true }
    );
  } finally {
    process.stdout.write = stdoutWrite;
  }
}

export async function main(
  args: string[] = process.argv.slice(2)
): Promise<void> {
  const command = parseWalletTransferAnalysisCommand(args);
  if (command.command === 'help') {
    process.stdout.write(WALLET_TRANSFER_ANALYSIS_HELP);
    return;
  }
  const result = await runInDbContext(command);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const usageError = error instanceof WalletTransferAnalysisUsageError;
    const safeError =
      usageError || error instanceof WalletTransferAnalysisError;
    process.stderr.write(
      `${JSON.stringify({
        error: safeError
          ? error.message
          : 'Wallet transfer analysis command failed.',
        code: usageError ? 'INVALID_ARGUMENTS' : 'EXECUTION_FAILED'
      })}\n`
    );
    process.exitCode = usageError ? 2 : 1;
  });
}
