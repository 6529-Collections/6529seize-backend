// 6529 run rebuild:check -- [options]. See docs/rebuild-check.md.
import * as path from 'node:path';
import { AREA_MANIFESTS } from '@/rebuild/manifests';
import { headline } from '@/rebuild/report/report';
import { runRebuildCheck } from '@/rebuild/run/runner';
import { parseSourceArg, SourceSpecs } from '@/rebuild/sources/source-spec';

const USAGE = `Usage: rebuild:check -- [options]
  --home <dir>          mysql data, runs and STATUS.md (default .rebuild)
  --area <area>         rebuild one area's tables only
  --mark head|switch    the world mark to rebuild to (default head)
  --final               the full proof: fail on everything a run otherwise only notes
  --mysql-port <n>      the private mysqld's port (default 3407)
  --api-port <n>        the API's port (default: a free port)
  --mysqld <path>       the mysqld binary
  --source <name=spec>  repeatable; spec is a URL (a devnet), replay:<dir>,
                        record:<dir>@<url>, files: <dir>, ethereum: anvil[:<state>],
                        relays: relay[:<dir>]
  --chain-height <n>    the chain height of the mark
  --eth-block <n>       the Ethereum block of the mark
  --validator-bin <file> the validator that re-serves a frozen gateway
                        recording's copies (called by its full path)
  --frozen-port <n>     the 127.0.0.1 port for that frozen node (1024-65535)
  --frozen-reviewed <commit>@<sha256>
                        the reviewed build: the capture's commit and the
                        replay binary's SHA-256. A frozen recording that
                        passes its checks counts as final only with it`;

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface Parsed {
  home: string;
  area: string | null;
  mark: 'head' | 'switch';
  final: boolean;
  mysqlPort: number;
  apiPort: number;
  mysqldPath?: string;
  sources: SourceSpecs;
  chainHeight: number | null;
  ethBlock: number | null;
  validatorBin?: string;
  frozenPort?: number;
  frozenReviewed?: string;
}

function number(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} needs a whole number`);
  }
  return parsed;
}

function parseSource(value: string, into: SourceSpecs): void {
  const [name, spec] = parseSourceArg(value);
  into[name] = spec;
}

export function parseArgs(argv: readonly string[], repoRoot: string): Parsed {
  const parsed: Parsed = {
    home: path.join(repoRoot, '.rebuild'),
    area: null,
    mark: 'head',
    final: false,
    mysqlPort: 3407,
    apiPort: 0,
    sources: {},
    chainHeight: null,
    ethBlock: null
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case '--home':
        parsed.home = path.resolve(value());
        break;
      case '--area':
        parsed.area = value();
        break;
      case '--mark': {
        const mark = value();
        if (mark !== 'head' && mark !== 'switch')
          throw new Error('--mark is head or switch');
        parsed.mark = mark;
        break;
      }
      case '--final':
        parsed.final = true;
        break;
      case '--mysql-port':
        parsed.mysqlPort = number(flag, value());
        break;
      case '--api-port':
        parsed.apiPort = number(flag, value());
        break;
      case '--mysqld':
        parsed.mysqldPath = value();
        break;
      case '--source':
        parseSource(value(), parsed.sources);
        break;
      case '--chain-height':
        parsed.chainHeight = number(flag, value());
        break;
      case '--eth-block':
        parsed.ethBlock = number(flag, value());
        break;
      case '--validator-bin':
        parsed.validatorBin = path.resolve(value());
        break;
      case '--frozen-port': {
        const port = number(flag, value());
        if (port < 1024 || port > 65535) {
          throw new Error(`${flag} needs a port from 1024 to 65535`);
        }
        parsed.frozenPort = port;
        break;
      }
      case '--frozen-reviewed': {
        const reviewed = value() ?? '';
        if (!/^[0-9a-f]{40}([0-9a-f]{24})?@[0-9a-f]{64}$/.test(reviewed)) {
          throw new Error(`${flag} needs <commit>@<sha256>, both in full`);
        }
        parsed.frozenReviewed = reviewed;
        break;
      }
      default:
        throw new Error(`Unknown option ${flag}\n${USAGE}`);
    }
  }
  return parsed;
}

async function main(): Promise<number> {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const options = parseArgs(process.argv.slice(2), repoRoot);
  const log = (line: string) =>
    say(`[rebuild ${new Date().toISOString()}] ${line}`);
  const { report, runDir } = await runRebuildCheck({
    ...options,
    frozen: {
      validator: options.validatorBin
        ? { file: options.validatorBin, command: [options.validatorBin] }
        : undefined,
      port: options.frozenPort,
      reviewed: options.frozenReviewed
    },
    repoRoot,
    manifests: AREA_MANIFESTS,
    log
  });
  for (const line of headline(report)) say(line);
  for (const failure of report.failures) say(`FAIL: ${failure}`);
  for (const problem of report.registryProblems) {
    say(`REGISTRY ${problem.kind}: ${problem.detail}`);
  }
  say(`Report: ${path.join(runDir, 'report.md')}`);
  return report.verdict === 'PASS' ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(2);
    }
  );
}
