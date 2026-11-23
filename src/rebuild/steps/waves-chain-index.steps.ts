import {
  ChainGatewayClient,
  chainGatewayConfigFromEnv
} from '@/chain-gateway/chain-gateway.client';
import { Logger } from '@/logging';
import { RebuildContext } from '@/rebuild/manifest.types';
import {
  ChainObject,
  GatewayWavesChainApi,
  WavesChainApi,
  WavesChainHead
} from '@/waves-chain-index/waves-chain-index.api';
import { ClaimBuildPort } from '@/waves-chain-index/waves-chain-index.claims';
import {
  WavesChainIndexDb,
  wavesChainIndexDb
} from '@/waves-chain-index/waves-chain-index.db';
import {
  FULL_READ_EVERY_MS,
  WavesChainIndex
} from '@/waves-chain-index/waves-chain-index.service';

const logger = Logger.get('WAVES_REBUILD_CHAIN_INDEX');

/** Runs of the index at one height before the step gives up. */
const MAX_RUNS_PER_HEIGHT = 50;

/**
 * The rebuild writes no claim build: chain_claim_builds is the outbox of
 * messages already sent, kept through the drop.
 */
const NO_CLAIM_BUILDS: ClaimBuildPort = {
  enabled: () => false,
  mainStage: () => new Set<string>(),
  send: async () => {
    throw new Error('The rebuild sends no claim build');
  }
};

/** The read stamp of one height: its block time and network. */
export interface PinnedHead extends WavesChainHead {
  readonly doneHeight: number | null;
  readonly completed: boolean;
}

/** What the index step needs from the gateway besides the index's reads. */
export interface ChainIndexSource {
  readonly api: WavesChainApi;
  /** The gateway's finalized height. */
  finalizedHeight(): Promise<number>;
  /** The waves import's state at `height`, with that block's time. */
  headAt(height: number): Promise<PinnedHead>;
}

export function gatewayChainIndexSource(baseUrl: string): ChainIndexSource {
  const client = new ChainGatewayClient(() => ({
    ...chainGatewayConfigFromEnv({ CHAIN_GATEWAY_URL: baseUrl }),
    cacheEntries: 64
  }));
  return {
    api: new GatewayWavesChainApi(client),
    // The status read whole: its heights and network checked.
    finalizedHeight: async () => (await client.getHead(true)).finalizedHeight,
    headAt: async (height) => {
      const answer = await client.read<ChainObject>(
        '/v1/waves/import',
        {},
        { height }
      );
      if (!answer) {
        throw new Error(`The gateway has no waves import at ${height}`);
      }
      const doneHeight = Number(answer.data?.doneHeight);
      return {
        finalizedHeight: height,
        finalizedTime: answer.read.time,
        network: answer.read.network ?? null,
        completed: answer.data?.completed === true,
        doneHeight: Number.isSafeInteger(doneHeight) ? doneHeight : null
      };
    }
  };
}

/** The index's reads, with its head held at one height. */
function pinnedTo(api: WavesChainApi, head: WavesChainHead): WavesChainApi {
  return new Proxy(api, {
    get(target, name, receiver) {
      if (name === 'head') return async () => head;
      const value = Reflect.get(target, name, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

/**
 * Runs the chain index (with its event log) as the live loop runs it, with
 * its head held at `head` and its clock at that block's time, until it has
 * read everything at that height: no full read under way and the feed
 * applied through it. The clock is the chain's, so the state's times
 * (last_full_at, updated_at) come out the same on every run.
 */
export async function indexAtHeight(
  api: WavesChainApi,
  db: WavesChainIndexDb,
  head: WavesChainHead
): Promise<number> {
  const time = head.finalizedTime;
  if (time === null) {
    throw new Error(
      `No block time for height ${head.finalizedHeight}: the index's clock needs it`
    );
  }
  const index = new WavesChainIndex(
    pinnedTo(api, head),
    db,
    () => time,
    FULL_READ_EVERY_MS,
    NO_CLAIM_BUILDS
  );
  for (let run = 1; run <= MAX_RUNS_PER_HEIGHT; run++) {
    // The clock stands still, so a run never meets its deadline: it stops
    // when its work at this height is done.
    const report = await index.run({ budgetMs: 1 });
    if (report.mode !== 'indexed') {
      throw new Error(
        `The chain index skipped height ${head.finalizedHeight}: ${report.skipped}`
      );
    }
    const state = await db.loadState();
    if (
      state.fullPhase === null &&
      state.feedNext !== null &&
      state.feedNext > head.finalizedHeight
    ) {
      return run;
    }
  }
  throw new Error(
    `The chain index did not reach height ${head.finalizedHeight} in ${MAX_RUNS_PER_HEIGHT} runs`
  );
}

/**
 * The index from empty, as 6529.io's index would have read it from the
 * switch: a full read at the height the waves import completed, then the
 * feed from there to `target`, so the event log holds every block after
 * the import. Returns the heights it read at.
 */
export async function indexChainTo(
  source: ChainIndexSource,
  db: WavesChainIndexDb,
  target: number | null
): Promise<number[]> {
  const finalized = await source.finalizedHeight();
  const height = target ?? finalized;
  if (height > finalized) {
    throw new Error(
      `The mark's chain height ${height} is past the gateway's finalized ${finalized}`
    );
  }
  const atMark = await source.headAt(height);
  if (!atMark.completed || atMark.doneHeight === null) {
    logger.info(
      `[WAVES IMPORT NOT COMPLETE AT ${height}] the chain index stays empty`
    );
    return [];
  }
  const heights =
    atMark.doneHeight < height ? [atMark.doneHeight, height] : [height];
  for (const at of heights) {
    const head = at === height ? atMark : await source.headAt(at);
    const runs = await indexAtHeight(source.api, db, head);
    logger.info(`[CHAIN INDEX AT ${at}] ${runs} runs`);
  }
  return heights;
}

function gatewayOf(ctx: RebuildContext): string {
  const gateway = ctx.sources.gateway;
  if (!gateway) {
    throw new Error(`${ctx.stepId} reads the chain: the run has no gateway`);
  }
  return gateway;
}

/** Seed: the index read forward to the mark, as the live loop does. */
export async function seedWavesChainIndex(ctx: RebuildContext): Promise<void> {
  await indexChainTo(
    gatewayChainIndexSource(gatewayOf(ctx)),
    wavesChainIndexDb,
    ctx.mark.chainHeight
  );
}

/** Rebuilder: the same reads into the emptied tables. */
export async function rebuildWavesChainIndex(
  ctx: RebuildContext
): Promise<void> {
  await indexChainTo(
    gatewayChainIndexSource(gatewayOf(ctx)),
    wavesChainIndexDb,
    ctx.mark.chainHeight
  );
}
