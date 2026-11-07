/**
 * Lists the Lambdas that sent WebSocket frames recently and flags any whose
 * deployed commit predates a required commit. Read-only: it lists functions,
 * searches their log groups for delivery EMF and asks the local git clone.
 *
 * Run from the repository root with the normal AWS credential chain:
 *
 *   bin/6529 exec ts-node ops/scripts/ws-sender-staleness/cli.ts \
 *     <staging|prod> <required-commit> [lookback-hours=24]
 *
 * Exit code 1 when any sender is stale or its commit is unknown locally
 * (fetch first), so it can gate a rollout.
 */
import { execFileSync } from 'node:child_process';
import { findStaleSenders, type DeployedFunction } from './staleness';

const REGIONS: Record<string, string> = {
  staging: 'eu-west-1',
  prod: 'us-east-1'
};
/** Namespace of the per-send delivery EMF that every sender writes. */
const DELIVERY_EMF = '"6529/WebSocketDelivery"';

function aws(args: string[]): string {
  return execFileSync('aws', [...args, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function git(args: string[]): boolean {
  try {
    execFileSync('git', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function listFunctions(region: string): DeployedFunction[] {
  const page = JSON.parse(
    aws(['lambda', 'list-functions', '--region', region])
  ) as { Functions: { FunctionName: string; Description?: string }[] };
  return page.Functions.map((fn) => ({
    name: fn.FunctionName,
    description: fn.Description ?? ''
  }));
}

function sendsFrames(region: string, sinceMs: number) {
  return async (functionName: string): Promise<boolean> => {
    try {
      const result = JSON.parse(
        aws([
          'logs',
          'filter-log-events',
          '--region',
          region,
          '--log-group-name',
          `/aws/lambda/${functionName}`,
          '--start-time',
          String(sinceMs),
          '--filter-pattern',
          DELIVERY_EMF,
          '--max-items',
          '1'
        ])
      ) as { events?: unknown[] };
      return (result.events?.length ?? 0) > 0;
    } catch {
      // A function without a log group has sent nothing.
      return false;
    }
  };
}

async function main(): Promise<number> {
  const [environment, requiredCommit, hours = '24'] = process.argv.slice(2);
  const region = REGIONS[environment ?? ''];
  const lookbackHours = Number(hours);
  if (
    !region ||
    !requiredCommit ||
    !Number.isFinite(lookbackHours) ||
    lookbackHours <= 0
  ) {
    process.stderr.write(
      'Usage: cli.ts <staging|prod> <required-commit> [lookback-hours=24]\n'
    );
    return 2;
  }
  if (!git(['cat-file', '-e', `${requiredCommit}^{commit}`])) {
    process.stderr.write(
      `Unknown required commit ${requiredCommit}; fetch first.\n`
    );
    return 2;
  }
  const reports = await findStaleSenders(
    listFunctions(region),
    requiredCommit,
    {
      sendsFrames: sendsFrames(region, Date.now() - lookbackHours * 3_600_000),
      knows: async (commit) => git(['cat-file', '-e', `${commit}^{commit}`]),
      contains: async (deployed, required) =>
        git(['merge-base', '--is-ancestor', required, deployed])
    }
  );
  for (const report of reports) {
    process.stdout.write(
      `${report.status.padEnd(14)} ${report.name.padEnd(40)} ${report.commit ?? '-'}\n`
    );
  }
  return reports.some((report) => report.status !== 'current') ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(2);
  }
);
