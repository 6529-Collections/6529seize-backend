import { promises as fs } from 'fs';
import * as path from 'path';
import {
  compareChainDay,
  CompareReport,
  summarizeReport
} from '../chain-day-compare';
import { verifyCutoff } from '../chain-day-verify';
import {
  ARWEAVE_HOSTS,
  DEFAULT_SITE_API,
  readSiteDayPublic
} from '../public-site-reader';
import { RateLimitedFetcher } from '../rate-limited-fetcher';
import { cycleDayOfDate, dateOfCycleDay, SiteDay } from '../site-day';
import { siteDayFromUploads } from '../site-uploads';
import {
  FileTdhChainSource,
  GatewayTdhChainSource,
  readChainDay,
  TdhChainSource
} from '../tdh-chain-source';
import { jsonRpcBlockReader } from './json-rpc-block-reader';

/**
 * The shadow compare: one TDH day on the 6529 chain against 6529.io's
 * values for the same day, exactly. Writes report.json and summary.txt to
 * --out and prints the summary. Exit 0 on MATCH, 1 on MISMATCH, 2 on bad
 * input or a failed read.
 */
export const TDH_CHAIN_COMPARE_HELP = `tdh-chain-compare: a TDH day on the 6529 chain against 6529.io's, exactly

  --day YYYY-MM-DD        the day (its boundary's date), or --cycle-day N
  --chain-gateway URL     read the chain's day from the gateway
  --chain-dir DIR         or from day files (tdh-chain-YYYYMMDD-wallets.csv, -tokens.csv)
  --site-api URL          read 6529.io's day from its public API (default ${DEFAULT_SITE_API})
  --site-dir DIR          or from saved uploads: wallets.csv and consolidated.csv
  --eth-rpc URL           also check the day's cutoff block against Ethereum
  --http-host HOST        allow plain http to this host (a devnet gateway); repeatable
  --out DIR               where report.json, summary.txt and the fetched inputs go

Public reads are unauthenticated GETs, one at a time, at most two a second.
`;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface CompareArgs {
  readonly cycleDay: number;
  readonly chainGateway: string | null;
  readonly chainDir: string | null;
  readonly siteApi: string;
  readonly siteDir: string | null;
  readonly ethRpc: string | null;
  readonly httpHosts: string[];
  readonly out: string;
}

export function parseCompareArgs(argv: string[]): CompareArgs | 'help' {
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return 'help';
    if (!a.startsWith('--')) throw new CliUsageError(`unexpected ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new CliUsageError(`${a} needs a value`);
    }
    values.set(a, [...(values.get(a) ?? []), v]);
    i++;
  }
  const known = [
    '--day',
    '--cycle-day',
    '--chain-gateway',
    '--chain-dir',
    '--site-api',
    '--site-dir',
    '--eth-rpc',
    '--http-host',
    '--out'
  ];
  for (const k of Array.from(values.keys())) {
    if (!known.includes(k)) throw new CliUsageError(`unknown option ${k}`);
  }
  const one = (k: string): string | null => {
    const v = values.get(k);
    if (!v) return null;
    if (v.length > 1 && k !== '--http-host') {
      throw new CliUsageError(`${k} given twice`);
    }
    return v[0];
  };
  const day = one('--day');
  const cycle = one('--cycle-day');
  if ((day === null) === (cycle === null)) {
    throw new CliUsageError('give one of --day or --cycle-day');
  }
  let cycleDay: number;
  if (day !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new CliUsageError('--day is YYYY-MM-DD');
    }
    cycleDay = cycleDayOfDate(day.replace(/-/g, ''));
  } else {
    if (!/^[1-9]\d*$/.test(cycle!)) throw new CliUsageError('--cycle-day');
    cycleDay = Number(cycle);
  }
  const chainGateway = one('--chain-gateway');
  const chainDir = one('--chain-dir');
  if ((chainGateway === null) === (chainDir === null)) {
    throw new CliUsageError('give one of --chain-gateway or --chain-dir');
  }
  const siteDir = one('--site-dir');
  const siteApi = one('--site-api');
  if (siteDir !== null && siteApi !== null) {
    throw new CliUsageError('give --site-api or --site-dir, not both');
  }
  const out = one('--out');
  if (out === null) throw new CliUsageError('--out is required');
  return {
    cycleDay,
    chainGateway,
    chainDir,
    siteApi: siteApi ?? DEFAULT_SITE_API,
    siteDir,
    ethRpc: one('--eth-rpc'),
    httpHosts: (values.get('--http-host') ?? []).map((h) => h.toLowerCase()),
    out
  };
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

export interface CompareRun {
  readonly report: CompareReport | null;
  readonly summary: string;
  readonly exitCode: 0 | 1 | 2;
}

export async function runCompare(
  args: CompareArgs,
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>
): Promise<CompareRun> {
  await fs.mkdir(path.join(args.out, 'inputs'), { recursive: true });
  const hosts = [...ARWEAVE_HOSTS, hostOf(args.siteApi)];
  if (args.chainGateway) hosts.push(hostOf(args.chainGateway));
  if (args.ethRpc) hosts.push(hostOf(args.ethRpc));
  const fetcher = new RateLimitedFetcher({
    allowedHosts: hosts,
    httpHosts: args.httpHosts,
    fetchFn
  });

  const source: TdhChainSource = args.chainGateway
    ? new GatewayTdhChainSource(args.chainGateway, fetcher)
    : new FileTdhChainSource(args.chainDir!);
  const day = await readChainDay(source, args.cycleDay);
  if (!day) {
    return {
      report: null,
      summary: `the chain source has no TDH day ${args.cycleDay} (${dateOfCycleDay(args.cycleDay)})\n`,
      exitCode: 2
    };
  }

  const date = dateOfCycleDay(args.cycleDay);
  let site: SiteDay;
  const notes: string[] = [];
  if (args.siteDir) {
    site = siteDayFromUploads(
      await fs.readFile(path.join(args.siteDir, 'wallets.csv'), 'utf8'),
      await fs.readFile(path.join(args.siteDir, 'consolidated.csv'), 'utf8')
    );
  } else {
    const read = await readSiteDayPublic(fetcher, date, args.siteApi);
    site = read.site;
    notes.push(...read.notes);
    for (const [name, body] of Object.entries(read.bodies)) {
      await fs.writeFile(path.join(args.out, 'inputs', name), body.body);
    }
  }

  const report = compareChainDay(day, site);
  const ethFailures = args.ethRpc
    ? await verifyCutoff(day.header, jsonRpcBlockReader(fetcher, args.ethRpc))
    : null;
  if (ethFailures) {
    notes.push(
      ethFailures.length === 0
        ? `Ethereum: block ${day.header.cutoffNumber} is the day's cutoff`
        : `Ethereum: ${ethFailures.map((f) => f.detail).join('; ')}`
    );
  }
  const full: CompareReport & {
    readonly ethereumCutoffChecked: boolean;
    readonly requests: typeof fetcher.log;
  } = {
    ...report,
    verdict:
      ethFailures && ethFailures.length > 0 ? 'MISMATCH' : report.verdict,
    notes: [...report.notes, ...notes],
    ethereumCutoffChecked: ethFailures !== null,
    requests: fetcher.log
  };
  const ethLine = notes.filter((n) => n.startsWith('Ethereum: '));
  const summary =
    summarizeReport(full) +
    ethLine
      .map(
        (n) => `${n}
`
      )
      .join('');
  await fs.writeFile(
    path.join(args.out, 'report.json'),
    JSON.stringify(full, null, 2)
  );
  await fs.writeFile(path.join(args.out, 'summary.txt'), summary);
  return { report: full, summary, exitCode: full.verdict === 'MATCH' ? 0 : 1 };
}

export async function main(argv: string[] = process.argv.slice(2)) {
  let args: CompareArgs | 'help';
  try {
    args = parseCompareArgs(argv);
  } catch (e) {
    process.stderr.write(
      `${(e as Error).message}\n\n${TDH_CHAIN_COMPARE_HELP}`
    );
    process.exitCode = 2;
    return;
  }
  if (args === 'help') {
    process.stdout.write(TDH_CHAIN_COMPARE_HELP);
    return;
  }
  try {
    const run = await runCompare(args);
    process.stdout.write(run.summary);
    process.exitCode = run.exitCode;
  } catch (e) {
    process.stderr.write(`tdh-chain-compare: ${(e as Error).message}\n`);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`${(e as Error).stack ?? e}\n`);
    process.exitCode = 2;
  });
}
