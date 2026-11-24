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
                        relays: relay[:<dir>], replay:<dir>[+<dir>],
                        record:<dir>@<url or relay>
  --chain-height <n>    the chain height of the mark
  --eth-block <n>       the Ethereum block of the mark`;

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
