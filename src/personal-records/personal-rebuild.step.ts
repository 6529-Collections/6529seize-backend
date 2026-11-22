import fetch from 'node-fetch';
import { JsonRpcProvider } from 'ethers';
import {
  COLLECT_LOG_LANE,
  CollectLogBody,
  parseCollectLogBody
} from '@/collecting/collecting-rules.log';
import type { SentEvidence } from '@/collecting/collecting-rules.chain-check';
import { nonceTransactionOnChain } from '@/collecting/collecting-rules.nonce-search';
import { collectingRulesService } from '@/collecting/collecting-rules.service';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import {
  compareOrderKeys,
  importOrderKey,
  RecordOrderKey
} from '@/signed-records/record-order';
import { dbSupplier } from '@/sql-executor';
import { Logger } from '@/logging';
import type { RebuildContext } from '@/rebuild/manifest.types';
import { RequestContext } from '@/request.context';
import { ethereumContractWalletCheck } from '@/signed-records/record-grant-proofs';
import {
  RecordIndexer,
  RecordRegistry,
  SenderKeyring
} from '@/signed-records/record-index';
import {
  RecordLogReader,
  RecordReplayContext,
  RecordsWaveReader,
  replayRecordLog,
  SegmentFetcher
} from '@/signed-records/record-log/record-log-reader';
import { RecordLogSegmenter } from '@/signed-records/record-log/record-log.service';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import { LocalRecordsWaveReader } from '@/signed-records/record-log/records-wave-local-reader';
import type { VerifiedRecord } from '@/signed-records/record-verify';
import { loadProviderKeys, ProviderKey } from '@/signed-records/sealed-crypto';
import { signedRecordHeadsDb } from '@/signed-records/signed-record-heads.db';
import {
  PERSONAL_IMPORT_LANE,
  PersonalImportBody,
  PersonalImportDone,
  PersonalRebuildReport,
  latestImport,
  personalExportDb,
  rebuildPersonalState
} from './personal-import';
import type { SignedCollectRule } from './collect-rule-records';
import { registerPersonalRecordTypes } from './personal-record-types';
import type { PersonalLiveEffects } from './personal-records.ports';
import { PERSONAL_LOG_LANE } from './personal-records.service';
import { personalRecordsStateDb } from './personal-records-state.db';
import { collectRuleDeps, personalTables } from './personal-records.wiring';
import {
  RecordOwnerDirectory,
  recordOwnerDirectory
} from './record-owner-directory';

const logger = Logger.get('PERSONAL_REBUILD');

/** The record log's personal settings entries, ready for a rebuild. */
export interface PersonalLogRead {
  readonly imports: (PersonalImportBody | PersonalImportDone)[];
  readonly records: VerifiedRecord[];
  // Personal settings events that no longer verify, by reason.
  readonly rejected: Record<string, number>;
  // The collect lane's entries, in the order they were logged.
  readonly collect?: CollectLogBody[];
}

/**
 * Walks both chains of the record log and keeps the personal settings: the
 * import's service entries (`personal-import`) and the people's signed
 * records (`personal`), each verified again against its own grant proof.
 */
export async function readPersonalLog(
  reader: RecordLogReader,
  replay: RecordReplayContext
): Promise<PersonalLogRead> {
  const read: PersonalLogRead = {
    imports: [],
    records: [],
    rejected: {},
    collect: []
  };
  for (const chain of ['public', 'private'] as const) {
    await replayRecordLog(reader, chain, replay, async ({ entry }, result) => {
      if (entry.t === 'entry' && entry.lane === PERSONAL_IMPORT_LANE) {
        read.imports.push(
          entry.body as unknown as PersonalImportBody | PersonalImportDone
        );
      } else if (entry.t === 'entry' && entry.lane === COLLECT_LOG_LANE) {
        try {
          read.collect!.push(parseCollectLogBody(entry.body));
        } catch {
          read.rejected['collect-format'] =
            (read.rejected['collect-format'] ?? 0) + 1;
        }
      } else if (entry.t === 'event' && entry.lane === PERSONAL_LOG_LANE) {
        if (result?.ok) {
          read.records.push(result.record);
        } else {
          const reason = result ? result.reason : 'unverified';
          read.rejected[reason] = (read.rejected[reason] ?? 0) + 1;
        }
      }
    });
  }
  return read;
}

/**
 * The switch state after a rebuild: the import's order key, and settings
 * open (the rebuilt table starts empty, so the row is new and unfrozen).
 */
export const restorePersonalSwitchState = (
  anchor: number,
  at: number
): Promise<void> => personalRecordsStateDb.restoreImport(anchor, at, {});

/**
 * Rebuilds the personal tables from a read of the log, restores the switch
 * state's import order key from the import's closing entry, and fails on
 * any record it could not take, so a difference never passes unnoticed.
 */
export async function runPersonalRebuild(deps: {
  readonly read: PersonalLogRead;
  readonly rebuild: (read: PersonalLogRead) => Promise<PersonalRebuildReport>;
  readonly setImport: (anchor: number, at: number) => Promise<void>;
}): Promise<PersonalRebuildReport> {
  const report = await deps.rebuild(deps.read);
  if (report.importOrder) {
    await deps.setImport(
      report.importOrder.anchor,
      report.importOrder.claimedTime
    );
  }
  const rejected = Object.entries(deps.read.rejected);
  logger.info(
    `[PERSONAL REBUILD] import entries ${report.importEntries}, records ${report.records}, before the import ${report.beforeImport}, refused ${report.refused.length}, rejected ${JSON.stringify(deps.read.rejected)}`
  );
  if (report.refused.length || rejected.length) {
    throw new Error(
      `The personal rebuild left out ${report.refused.length} refused and ${rejected.reduce((sum, [, count]) => sum + count, 0)} rejected records: ${report.refused
        .slice(0, 5)
        .map((it) => `${it.what} (${it.detail})`)
        .join('; ')}`
    );
  }
  return report;
}

// A rebuild changes tables only: none of today's side effects run.
const NO_LIVE_EFFECTS = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error('A rebuild has no live effects');
    }
  }
) as PersonalLiveEffects;

/** Segment files from the run's files source (`/ipfs/<cid>`, `/ar/<id>`). */
function filesFetcher(base: string): SegmentFetcher {
  const get = async (path: string): Promise<Buffer> => {
    const response = await fetch(`${base.replace(/\/$/, '')}${path}`);
    if (!response.ok) {
      throw new Error(`${path} answered ${response.status}`);
    }
    return response.buffer();
  };
  return {
    fetchCid: (cid) => get(`/ipfs/${encodeURIComponent(cid)}`),
    fetchArweave: (id) => get(`/ar/${encodeURIComponent(id)}`)
  };
}

function recordsWaveOf(env: Readonly<Record<string, string | undefined>>): {
  wave: RecordsWaveReader;
  serviceWallet: string;
} {
  const waveId = env.SIGNED_RECORDS_WAVE_ID;
  const profileId = env.SIGNED_RECORDS_SERVICE_PROFILE_ID;
  const wallet = env.SIGNED_RECORDS_SERVICE_WALLET?.toLowerCase();
  if (!waveId || !profileId || !wallet) {
    throw new Error(
      'SIGNED_RECORDS_WAVE_ID, SIGNED_RECORDS_SERVICE_PROFILE_ID and SIGNED_RECORDS_SERVICE_WALLET are needed to read the records wave'
    );
  }
  return {
    wave: new LocalRecordsWaveReader({ waveId, profileId, wallet }),
    serviceWallet: wallet
  };
}

/** The segment table again, from the records wave's head and archive drops. */
async function restoreSegments(
  wave: RecordsWaveReader,
  serviceWallet: string,
  providers: readonly ProviderKey[]
): Promise<number> {
  const unused = () => {
    throw new Error('A rebuild writes no segment');
  };
  const segmenter = new RecordLogSegmenter({
    store: recordLogDb,
    providers,
    pinner: { pin: unused, fetch: unused },
    archiver: { upload: unused },
    poster: { post: unused },
    wave,
    serviceWallets: [serviceWallet]
  });
  return segmenter.restore({});
}

/**
 * The rebuild check's step for the personal tables (the personal
 * settings manifest). Reads the records wave from the rebuilt drops, the segment
 * files from the files source and verifies every record again (bindings
 * from the chain gateway, contract wallets from Ethereum); then:
 * 1. the segment table, from the records wave;
 * 2. what the waves index implies (one's own waves and drops);
 * 3. the latest complete import, then the records after it;
 * 4. the switch state's import order key.
 * The audit rows of people's own blocks and hides are not written here:
 * the audit log's rebuild takes them from personalModerationAuditRows.
 */
export async function rebuildPersonalTables(
  ctx: RebuildContext,
  env: Readonly<Record<string, string | undefined>> = process.env,
  owners: RecordOwnerDirectory = recordOwnerDirectory
): Promise<void> {
  if (!ctx.sources.files) {
    throw new Error(
      'The personal rebuild reads segment files: no files source'
    );
  }
  const providers = loadProviderKeys(env.SIGNED_RECORDS_PROVIDER_KEYS);
  if (providers.length === 0) {
    throw new Error('SIGNED_RECORDS_PROVIDER_KEYS is not configured');
  }
  const { wave, serviceWallet } = recordsWaveOf(env);
  const restored = await restoreSegments(wave, serviceWallet, providers);
  logger.info(`[PERSONAL REBUILD] ${restored} segment rows restored`);
  const read = await readPersonalLog(
    new RecordLogReader({
      wave,
      fetcher: filesFetcher(ctx.sources.files),
      serviceWallets: [serviceWallet],
      providers
    }),
    {
      bindings: owners,
      ...(ctx.sources.ethereum
        ? { contractWallets: ethereumContractWalletCheck }
        : {})
    }
  );
  // collect.rule records keep their heads here and are kept as signed; the
  // collect pass below applies rules in the collect lane's order.
  const signedRules = new Map<string, SignedCollectRule>();
  const registry = registerPersonalRecordTypes(
    new RecordRegistry(),
    {
      owners,
      tables: personalTables,
      live: NO_LIVE_EFFECTS,
      collect: collectRuleDeps
    },
    { deferredCollectRules: signedRules }
  );
  const requestContext: RequestContext = {};
  await runPersonalRebuild({
    read,
    rebuild: (log) =>
      rebuildPersonalState({
        indexer: new RecordIndexer({
          registry,
          heads: signedRecordHeadsDb,
          keyring: new SenderKeyring(providers)
        }),
        heads: signedRecordHeadsDb,
        imports: log.imports,
        records: log.records,
        derive: (c) => personalExportDb.deriveFromWavesIndex(c),
        ctx: requestContext
      }),
    setImport: restorePersonalSwitchState
  });
  const done = latestImport(read.imports).done;
  const collect = await replayCollectLog({
    entries: read.collect ?? [],
    importOrder: done ? importOrderKey(done.anchor, done.at) : null,
    records: new Map(
      read.records.map((record) => [record.event.id, record.order])
    ),
    signed: signedRules,
    chain: ctx.sources.ethereum ? chainReader(ctx.sources.ethereum) : null,
    replay: (body, evidence) =>
      dbSupplier().executeNativeQueriesInTransaction((connection) =>
        collectingRulesService.replay(body, connection, evidence)
      )
  });
  logger.info(
    `[PERSONAL REBUILD] collect entries applied ${collect.applied}, refused ${collect.refused.length}`
  );
  if (collect.refused.length) {
    throw new Error(
      `The Collect rules rebuild left out ${collect.refused.length} entries: ${collect.refused
        .slice(0, 5)
        .map((it) => `${it.what} (${it.detail})`)
        .join('; ')}`
    );
  }
}

/** What Ethereum shows for a sent hash: its transaction and receipt. */
function chainReader(url: string): (hash: string) => Promise<SentEvidence> {
  const provider = new JsonRpcProvider(url, undefined, { staticNetwork: true });
  return async (hash) => {
    const [transaction, receipt] = await Promise.all([
      provider.getTransaction(hash),
      provider.getTransactionReceipt(hash)
    ]);
    return {
      transaction: transaction
        ? {
            from: transaction.from,
            to: transaction.to,
            value: transaction.value,
            nonce: transaction.nonce
          }
        : null,
      receipt: receipt
        ? {
            status: receipt.status,
            gasUsed: receipt.gasUsed,
            gasPrice: receipt.gasPrice,
            logs: receipt.logs.map((log) => ({
              address: log.address,
              topics: log.topics,
              data: log.data
            }))
          }
        : null,
      minedNonce: (wallet) => provider.getTransactionCount(wallet, 'safe'),
      nonceTransaction: (wallet, nonce) =>
        nonceTransactionOnChain(provider, wallet, nonce)
    };
  };
}

/** Why a `rule` entry isn't what the person signed, or null when it is. */
function signedRuleProblem(
  body: Extract<CollectLogBody, { kind: 'rule' }>,
  signed: SignedCollectRule | undefined
): string | null {
  if (!signed) return `record ${body.event_id} was not opened as a rule`;
  if (
    signed.rule !== body.rule ||
    signed.profileId !== body.profile_id ||
    signed.paused !== body.paused ||
    canonicalizeJson(signed.definition as never) !==
      canonicalizeJson(body.definition as never)
  ) {
    return `the entry differs from record ${body.event_id} as signed`;
  }
  return null;
}

/**
 * The collect lane after the import, in logged order (the order the
 * changes were made live), each through the same store functions and
 * checks at its logged (server) time. What the import holds is not
 * replayed: a rule change whose record is ordered at or before the
 * import's order key (as the personal records rebuild decides), a server
 * entry logged before the import's time. A sent hash is replayed whatever
 * its time: it may have been logged while settings were frozen, after the
 * import read its binding, and setting it again changes nothing.
 * A rule change must say what the person's record says; a settlement, and
 * a release of a sent transaction, must match Ethereum. Anything else is
 * left out and reported.
 */
export async function replayCollectLog(args: {
  readonly entries: readonly CollectLogBody[];
  readonly importOrder: RecordOrderKey | null;
  // Every verified record's order key, by event id.
  readonly records: ReadonlyMap<string, RecordOrderKey>;
  // The collect.rule records the first pass opened, by event id.
  readonly signed: ReadonlyMap<string, SignedCollectRule>;
  readonly chain: ((hash: string) => Promise<SentEvidence>) | null;
  readonly replay: (
    body: CollectLogBody,
    evidence?: SentEvidence
  ) => Promise<void>;
}): Promise<{
  applied: number;
  refused: { what: string; detail: string }[];
}> {
  const refused: { what: string; detail: string }[] = [];
  let applied = 0;
  const { importOrder } = args;
  for (const body of args.entries) {
    const what = `collect ${body.kind} ${body.rule}`;
    if (body.kind === 'rule') {
      const order = args.records.get(body.event_id);
      if (!order) {
        refused.push({ what, detail: `no verified record ${body.event_id}` });
        continue;
      }
      if (importOrder && compareOrderKeys(order, importOrder) <= 0) continue;
      const problem = signedRuleProblem(body, args.signed.get(body.event_id));
      if (problem) {
        refused.push({ what, detail: problem });
        continue;
      }
    } else if (
      body.kind !== 'sent' &&
      importOrder &&
      body.at < importOrder.claimedTime
    ) {
      continue;
    }
    const hash =
      body.kind === 'settle'
        ? body.settlement.transaction_hash
        : body.kind === 'released'
          ? body.transaction_hash
          : null;
    let evidence: SentEvidence | undefined;
    if (hash) {
      if (!args.chain) {
        refused.push({ what, detail: 'no Ethereum source to check it' });
        continue;
      }
      evidence = await args.chain(hash);
    }
    try {
      await args.replay(body, evidence);
      applied++;
    } catch (error) {
      refused.push({ what, detail: (error as Error).message });
    }
  }
  return { applied, refused };
}
