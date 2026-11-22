import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { doInDbContext } from '@/secrets';
import {
  IdentityDirectory,
  MapIdentityDirectory,
  mirrorIdentityDirectory
} from '../identity/identity-directory';
import {
  claimSubscriptionWrites,
  openSubscriptionWrites,
  subscriptionsIdentitySwitch,
  suspendIdentityTables
} from '../identity/identity-switch';
import { goLive } from './go-live';
import {
  boundJournalSource,
  fetchNamedOpening,
  publicFetcher,
  readJournal,
  rebuildIdentityTables
} from './rebuild';
import type { JournalBody } from '../timeline/journal';
import {
  alertOnJournalFailures,
  EthereumFacts,
  verifyJournal
} from '../timeline/journal-verify';
import { assertOutsideRepository, parseArgs } from '../parity/cli';
import { cutOpeningFiles } from './opening-build';
import { compareAndMarkVerified } from './opening-compare';
import { loadOpeningFiles, parseOpeningFiles } from './opening-load';
import {
  EthMintsFixture,
  EthTopUpsFixture,
  verifyOpening
} from './opening-verify';

/**
 * The opening file at the identity switch.
 *
 *   cut      read the legacy tables in one transaction and write the opening
 *            and history files (named by their sha256)
 *   verify   check the files on their own and, with fixtures, against
 *            Ethereum; no database
 *   load     empty the identity tables and load the files (unverified)
 *   compare  the opening comparison: the identity tables hold the files and the legacy tables
 *            still give the same files; on a match, mark them verified
 *   go-live  the switch in one step (go-live.ts): check the shadow
 *            comparisons on the last minted card, pause unsigned writes,
 *            cut, verify, load, compare, publish the files, set the switch
 *            time, reopen the write routes
 *   rebuild  empty or suspended identity tables from the last opening that
 *            went live and the journal in the record log (or, rehearsing,
 *            from given files); --go-live is for a lost database: it
 *            refuses unless the identity tables and their state row are
 *            empty, and, while the legacy tables hold rows, unless
 *            --lost-database is given; it switches if the checkpoints
 *            match. After a suspend, switch with go-live, which cuts from
 *            the legacy tables
 *   verify-journal  check the journal of an opening against the money
 *            rules, from the opening file's balances on, and its top-ups
 *            and mints against Ethereum (rebuild runs the same check
 *            first). --no-ethereum leaves Ethereum out, for rehearsals; a
 *            rebuild with --go-live refuses it
 *   status   whether the identity tables are the truth, and why
 *   suspend  rollback: every reader is on the legacy tables within 60 s
 *            (API answers can be cached a minute more)
 *   open-writes  delete go-live's writes-closed marker, after a go-live
 *            that died before it could reopen the write routes
 *
 * Files name wallets, so they are written outside the repository.
 */

const USAGE = `usage:
  cut     --out-dir <dir> [--identities <wallet-to-identity json>]
  verify  --opening <json> --history <json> [--eth-top-ups <json>] [--eth-mints <json>] --out <json>
  load    --opening <json> --history <json>
  compare --opening <json> --history <json> [--identities <json>] --out <json>
  go-live --out-dir <dir> --signed-writes-live [--accept-report-diffs]
  rebuild [--opening <json> --history <json>] [--go-live [--lost-database] | --no-ethereum]
  verify-journal [--opening-sha256 <sha256> | --opening <json> --history <json>] [--no-ethereum] [--out <json>]
  status
  suspend
  open-writes`;

type Args = Record<string, string | true>;

function required(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`--${name} is required\n${USAGE}`);
  }
  return value;
}

function optional(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function writeOut(path: string, text: string) {
  assertOutsideRepository(path);
  writeFileSync(path, text);
}

function directoryFrom(args: Args): IdentityDirectory {
  const file = optional(args, 'identities');
  return file
    ? new MapIdentityDirectory(
        JSON.parse(readText(file)) as Record<string, string>
      )
    : mirrorIdentityDirectory;
}

function parsedFrom(args: Args) {
  return parseOpeningFiles(
    readText(required(args, 'opening')),
    readText(required(args, 'history'))
  );
}

async function cutCommand(args: Args): Promise<number> {
  const outDir = required(args, 'out-dir');
  const files = await cutOpeningFiles(directoryFrom(args));
  const openingPath = join(outDir, `opening-${files.openingSha256}.json`);
  const historyPath = join(outDir, `history-${files.historySha256}.json`);
  writeOut(historyPath, files.historyBytes);
  writeOut(openingPath, files.openingBytes);
  const t = files.opening.totals;
  process.stdout.write(
    [
      `opening ${files.openingSha256} ${openingPath}`,
      `history ${files.historySha256} ${historyPath}`,
      `cut ${files.opening.cut.at}, newest Meme ${files.opening.cut.maxMemeId}`,
      `${t.keys} keys, ${t.identities} identities, ${t.balances} balances, ${t.choices} open choices, ${t.topUps} top-ups, ${t.finalRows} final rows, ${t.redeemedRows} redemptions, ${files.history.logs.length} log lines`,
      `${files.opening.blocked.length} blocked keys, ${files.opening.attribution.length} history rows attributed by rule`
    ].join('\n') + '\n'
  );
  return files.opening.blocked.length === 0 ? 0 : 2;
}

function verifyCommand(args: Args): number {
  const topUps = optional(args, 'eth-top-ups');
  const mints = optional(args, 'eth-mints');
  const report = verifyOpening(parsedFrom(args), {
    topUps: topUps
      ? (JSON.parse(readText(topUps)) as EthTopUpsFixture)
      : undefined,
    mints: mints ? (JSON.parse(readText(mints)) as EthMintsFixture) : undefined
  });
  writeOut(required(args, 'out'), JSON.stringify(report, null, 2) + '\n');
  for (const c of report.checks) {
    process.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}\n`);
  }
  const k = report.conservation;
  process.stdout.write(
    `conservation: ${k.identities} identities, ${k.exact} exact, ${k.rounding} within rounding, ${k.adjustments.length} adjustments totalling ${k.adjustmentSum}\n${report.verdict}\n`
  );
  return report.verdict === 'PASS' ? 0 : 2;
}

async function loadCommand(args: Args): Promise<number> {
  const parsed = parsedFrom(args);
  // The load holds the write pause, so no go-live or rebuild runs with it.
  if (!(await claimSubscriptionWrites())) {
    process.stderr.write(
      'Refusing: another go-live, load or rebuild holds the write pause; wait for it to end, or run open-writes if it died.\n'
    );
    return 2;
  }
  try {
    await loadOpeningFiles(parsed);
  } finally {
    await openSubscriptionWrites();
  }
  process.stdout.write(
    `loaded ${parsed.openingSha256}; not the truth until compare passes\n`
  );
  return 0;
}

async function compareCommand(args: Args): Promise<number> {
  const result = await compareAndMarkVerified(
    parsedFrom(args),
    directoryFrom(args)
  );
  writeOut(required(args, 'out'), JSON.stringify(result, null, 2) + '\n');
  for (const d of result.diffs) {
    const ok = d.missingCount === 0 && d.extraCount === 0;
    process.stdout.write(
      `${ok ? 'ok  ' : 'DIFF'} ${d.section}: ${d.expected} expected, ${d.actual} found, ${d.missingCount} missing, ${d.extraCount} extra\n`
    );
  }
  process.stdout.write(
    result.ok
      ? 'Opening comparison MATCH: the identity tables are verified\n'
      : 'Opening comparison DIFF: nothing marked; the legacy tables stay the truth\n'
  );
  return result.ok ? 0 : 2;
}

/**
 * The switch, in one step. Refuses unless signed subscription writes are
 * live (otherwise every change gets a 409) and the shadow comparisons match;
 * then cuts at the switch, verifies, loads, compares and sets the
 * switch time, so the identity tables are the truth from a cut taken now.
 */
async function goLiveCommand(args: Args): Promise<number> {
  if (optional(args, 'identities')) {
    process.stderr.write(
      'Refusing: go-live keys the truth by the identity mirror, as the writers do; --identities is for rehearsals.\n'
    );
    return 2;
  }
  const outDir = required(args, 'out-dir');
  const { getMaxMemeId } = await import('@/nftsLoop/db.nfts');
  const result = await goLive({
    signedWritesLive: args['signed-writes-live'] === true,
    acceptReportDiffs: args['accept-report-diffs'] === true,
    mintedCard: await getMaxMemeId(),
    saveFile: (name, text) => writeOut(join(outDir, name), text)
  });
  for (const line of result.steps) {
    process.stdout.write(`${line}\n`);
  }
  return result.switched ? 0 : 2;
}

/** Rebuilds the identity tables from the published chain's head. */
async function rebuildCommand(args: Args): Promise<number> {
  if (optional(args, 'identities')) {
    process.stderr.write(
      'Refusing: a rebuild writes back what the journal holds; it reads no directory.\n'
    );
    return 2;
  }
  const rehearsal = optional(args, 'opening') ? parsedFrom(args) : undefined;
  const goLive = args['go-live'] === true;
  if (goLive && args['no-ethereum'] === true) {
    process.stderr.write(
      'Refusing: a rebuild goes live only with its journal checked against Ethereum.\n'
    );
    return 2;
  }
  const result = await rebuildIdentityTables({
    source: boundJournalSource(),
    opening: rehearsal,
    goLive,
    lostDatabase: args['lost-database'] === true,
    ethereum: await ethereumFrom(args)
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return goLive && !result.switched ? 2 : 0;
}

/** The backend's own Ethereum reads, unless --no-ethereum is given. */
async function ethereumFrom(args: Args): Promise<EthereumFacts | undefined> {
  if (args['no-ethereum'] === true) {
    return undefined;
  }
  const { backendEthereumFacts } =
    await import('../timeline/journal-verify-ethereum');
  return backendEthereumFacts();
}

/** The opening a journal went live with last, or else the one its last entry was written against. */
function journalOpening(bodies: readonly JournalBody[]): string | null {
  const switched = bodies.filter((b) => b.kind === 'opening').pop();
  if (switched) {
    return String(switched.inputs.opening_sha256);
  }
  return bodies.length > 0 ? bodies[bodies.length - 1].opening : null;
}

/** Verifies the journal of one opening (journal-verify.ts) and prints what failed. */
async function verifyJournalCommand(args: Args): Promise<number> {
  const files = optional(args, 'opening') ? parsedFrom(args) : undefined;
  const { bodies, events } = await readJournal(boundJournalSource());
  const openingSha256 =
    optional(args, 'opening-sha256') ??
    files?.openingSha256 ??
    journalOpening(bodies);
  if (!openingSha256) {
    process.stderr.write('The journal holds no entry to verify.\n');
    return 2;
  }
  if (files && files.openingSha256 !== openingSha256) {
    process.stderr.write(
      `--opening hashes to ${files.openingSha256}, not ${openingSha256}\n`
    );
    return 2;
  }
  // Without files, the opening the journal names, fetched as a rebuild does.
  const named = bodies
    .filter(
      (b) => b.kind === 'opening' && b.inputs.opening_sha256 === openingSha256
    )
    .pop();
  const opening =
    files ??
    (named ? (await fetchNamedOpening(named, publicFetcher)).parsed : null);
  const report = await verifyJournal(bodies, {
    openingSha256,
    opening: opening?.opening,
    ethereum: await ethereumFrom(args),
    events: events ?? undefined
  });
  const out = optional(args, 'out');
  if (out) {
    writeOut(out, JSON.stringify(report, null, 2) + '\n');
  }
  const c = report.counts;
  const lines = [
    `opening ${openingSha256}: ${report.writes} writes, ${c.topUps} top-ups, ${c.charges} charges over ${c.mints} mints, ${c.choices} choices`,
    report.checked.opening
      ? 'opening file: checked'
      : 'opening file: not checked (the journal names no published file for it; pass --opening --history)',
    report.checked.ethereum
      ? 'Ethereum: checked'
      : 'Ethereum: not checked (--no-ethereum)',
    report.checked.events
      ? 'signed records: checked'
      : 'signed records: not checked (the bound source does not verify records)',
    ...report.failures.map((f) => `FAIL ${f}`),
    report.failures.length === 0
      ? 'PASS'
      : `FAIL: ${report.failures.length} failures`
  ];
  process.stdout.write(lines.join('\n') + '\n');
  return alertOnJournalFailures(report) ? 0 : 2;
}

async function statusCommand(): Promise<number> {
  subscriptionsIdentitySwitch.invalidate();
  const status = await subscriptionsIdentitySwitch.status();
  process.stdout.write(`${JSON.stringify(status)}\n`);
  return 0;
}

async function openWritesCommand(): Promise<number> {
  await openSubscriptionWrites();
  process.stdout.write('the unsigned write routes are open\n');
  return 0;
}

async function suspendCommand(): Promise<number> {
  const suspended = await suspendIdentityTables();
  process.stdout.write(
    suspended
      ? 'suspended: every reader is on the legacy tables within 60 s\n'
      : 'nothing loaded to suspend\n'
  );
  return suspended ? 0 : 2;
}

export async function main(argv: readonly string[]): Promise<number> {
  const { command, args } = parseArgs(argv);
  const inDb = (fn: () => Promise<number>) =>
    doInDbContext(fn, { skipRedis: true });
  switch (command) {
    case 'cut':
      return inDb(() => cutCommand(args));
    case 'verify':
      return verifyCommand(args);
    case 'load':
      return inDb(() => loadCommand(args));
    case 'compare':
      return inDb(() => compareCommand(args));
    case 'rebuild':
      return inDb(() => rebuildCommand(args));
    case 'verify-journal':
      return inDb(() => verifyJournalCommand(args));
    case 'go-live':
      return inDb(() => goLiveCommand(args));
    case 'status':
      return inDb(statusCommand);
    case 'suspend':
      return inDb(suspendCommand);
    case 'open-writes':
      return inDb(openWritesCommand);
    default:
      process.stderr.write(`${USAGE}\n`);
      return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exit(1);
    });
}
