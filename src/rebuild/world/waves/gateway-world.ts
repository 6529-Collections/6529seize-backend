import * as http from 'node:http';
import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import { closeServer, listenLoopback } from '@/rebuild/sources/running-source';
import {
  FakeChain,
  FakeClock,
  id
} from '@/tests/fixtures/waves-chain-index.fixture';
import {
  ChainObject,
  ChainPage
} from '@/waves-chain-index/waves-chain-index.api';
import { WAVES_WORLD_IDS } from './world-ids';

/**
 * The waves area's hand-written chain for the rebuild check: a gateway in
 * small, serving the waves read routes the chain index uses from the chain
 * index's test chain (src/tests/fixtures/waves-chain-index.fixture.ts), at
 * every height. Made-up ids only. The tests use it (the chain index step,
 * the gateway capture); the runs replay a devnet's recording
 * (src/rebuild/world/waves/gateway), made with gateway-capture.
 *
 * Heights: the imported waves are written first and the waves import
 * completes at `doneHeight`; native writes follow (votes, a ballot, a
 * rating, a settled result, a released entry) up to `markHeight`.
 */
export interface WavesGatewayWorld {
  readonly chain: FakeChain;
  readonly doneHeight: number;
  readonly markHeight: number;
  /**
   * Heights the node serves only as head views, never finalized (finality
   * moves a checkpoint at a time): a pinned read there is stamped `head`.
   */
  readonly headViews?: ReadonlySet<number>;
}

const G1 = id('91');
const G2 = id('92');
const W1 = id('a1');
const W2 = id('a2');
const P1 = id('b1');
const D1 = id('d1');
const D2 = id('d2');
const D3 = id('d3');
const E = (n: number) => id(`e${n}`);
const V = (n: number) => id(`f${n}`);
const CID = id('c5');

/** The legacy ids the imported objects carry (made up). */
export const WORLD_LEGACY_IDS = {
  publicWave: WAVES_WORLD_IDS.publicWave,
  membersWave: WAVES_WORLD_IDS.membersWave,
  group: WAVES_WORLD_IDS.group
} as const;

export function buildWavesGatewayWorld(): WavesGatewayWorld {
  const clock = new FakeClock();
  const chain = new FakeChain(clock);
  // Imported: two groups, a members-only wave and a public one, a poll, a
  // counted decision with three entries, an ended one with a result, a
  // decision ranked by total.
  chain.putGroup(G1, { legacyId: WORLD_LEGACY_IDS.group });
  chain.putGroup(G2);
  chain.putWave(W1, {
    legacyId: WORLD_LEGACY_IDS.membersWave,
    origin: 'legacy',
    readGroup: { groupId: G1, version: 0 },
    membersOnly: true
  });
  chain.putWave(W2, {
    legacyId: WORLD_LEGACY_IDS.publicWave,
    origin: 'legacy'
  });
  chain.putRole(W1, V(1));
  chain.rate(W1, V(2), 7);
  chain.putPoll(P1, W1);
  const resultTime = clock.t + 3_600_000;
  chain.putDecision(D1, W1, { counted: true, nextResultTime: resultTime });
  chain.putDecision(D2, W2, { status: 'ended' });
  chain.putDecision(D3, W2, { kind: 'approve' });
  chain.putEntry(E(1), D1);
  chain.putEntry(E(2), D1);
  chain.putEntry(E(3), D1);
  chain.putEntry(E(4), D2, { status: 'winner' });
  chain.putEntry(E(6), D3);
  chain.vote(E(1), V(1), 5);
  chain.vote(E(1), V(2), 3);
  chain.vote(E(2), V(1), 1);
  chain.vote(E(3), V(3), 2);
  chain.vote(E(4), V(1), 9);
  chain.vote(E(6), V(2), 4);
  chain.putResult(D2, 1_700_000_000_000);
  const doneHeight = chain.height;
  // Native, after the import: moved and new votes, a ballot, a rating, a
  // group replaced, a role, the counted decision settled, a vote released.
  chain.tick(60_000);
  chain.vote(E(1), V(1), 6);
  chain.vote(E(2), V(3), 4);
  chain.ballot(P1, CID, 1);
  chain.rate(W1, V(3), 2);
  chain.putGroup(G2, { legacyId: null });
  chain.putRole(W2, V(2));
  chain.tick(3_600_000);
  chain.settle(D1, resultTime, [E(1)]);
  chain.release(E(2), V(1));
  chain.tick(60_000);
  return { chain, doneHeight, markHeight: chain.height };
}

type Query = URLSearchParams;

interface Answer {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

/** The world's network id: 32 bytes of hex, as the node gives it (made up). */
export const WORLD_NETWORK = `0x${'ab'.repeat(32)}`;

/** The node's not_found: a 404 with its read stamp. */
const notFound = (
  chain: FakeChain,
  path: string,
  height = chain.height
): Answer => ({
  status: 404,
  json: {
    read: stampAt(chain, height),
    error: { code: 'not_found', message: `${path}: not found` }
  }
});

function timeAt(chain: FakeChain, height: number): number {
  // The fake keeps each height's time privately; the routes give it in
  // every read stamp, as the node does.
  return (chain as unknown as { timeAt(at: number): number }).timeAt(height);
}

function stampAt(chain: FakeChain, height: number) {
  return {
    at: 'finalized',
    height,
    root: id(0),
    slot: height,
    time: timeAt(chain, height),
    finalizedHeight: chain.height,
    headHeight: chain.height,
    network: WORLD_NETWORK
  };
}

function heightOf(chain: FakeChain, query: Query): number {
  const raw = query.get('height');
  const height = raw === null ? chain.height : Number(raw);
  if (!Number.isSafeInteger(height) || height < 0 || height > chain.height) {
    throw new ChainGatewayError(
      `no height ${raw}`,
      410,
      'height_gone',
      'height'
    );
  }
  return height;
}

function one(
  chain: FakeChain,
  path: string,
  height: number,
  data: ChainObject | null
): Answer {
  return data === null
    ? notFound(chain, path, height)
    : { status: 200, json: { read: stampAt(chain, height), data } };
}

function page(
  chain: FakeChain,
  height: number,
  answer: ChainPage<ChainObject>
): Answer {
  return {
    status: 200,
    json: {
      read: stampAt(chain, height),
      data: answer.items,
      next: answer.next
    }
  };
}

function all(
  chain: FakeChain,
  path: string,
  height: number,
  items: ChainObject[] | null
): Answer {
  return items === null
    ? notFound(chain, path, height)
    : {
        status: 200,
        json: { read: stampAt(chain, height), data: items, next: null }
      };
}

/** One GET of the gateway's read API, answered from the world. */
export async function answerGatewayRequest(
  world: WavesGatewayWorld,
  rawUrl: string
): Promise<Answer> {
  const answer = await answerAtHeight(world, rawUrl);
  const asked = new URL(rawUrl, 'http://world').searchParams.get('height');
  const read = answer.json.read as Record<string, unknown> | undefined;
  if (asked !== null && read && world.headViews?.has(Number(asked))) {
    // As the node answers a height it holds only as a head view.
    return {
      ...answer,
      json: { ...answer.json, read: { ...read, at: 'head' } }
    };
  }
  return answer;
}

async function answerAtHeight(
  world: WavesGatewayWorld,
  rawUrl: string
): Promise<Answer> {
  const { chain, doneHeight } = world;
  const url = new URL(rawUrl, 'http://world');
  const path = url.pathname;
  const query = url.searchParams;
  const after = query.get('after');
  const parts = path.split('/').filter(Boolean);
  if (path === '/v1/status') {
    const stamp = stampAt(chain, chain.height);
    return {
      status: 200,
      json: {
        read: stamp,
        data: {
          api: 'world',
          node: 'world',
          ready: true,
          head: stamp,
          finalized: stamp,
          pinnable: { from: 0, to: chain.height },
          ruleVersion: 7
        }
      }
    };
  }
  if (path === '/v1/feed') {
    // A cursor is a height, or `height:index` inside a block; the world's
    // pages never cut a block, so an index only trims the first one.
    const [fromHeight, fromIndex = 0] = String(query.get('from'))
      .split(':')
      .map(Number);
    const feed = await chain.feed(fromHeight);
    const blocks = feed.blocks.map((block) => {
      const recordsFrom = block.height === fromHeight ? fromIndex : 0;
      return {
        ...block,
        records: block.records.slice(recordsFrom),
        complete: true,
        recordsFrom
      };
    });
    return {
      status: 200,
      json: {
        read: stampAt(chain, chain.height),
        data: { from: feed.from, through: feed.through, blocks },
        next: Math.max(feed.through + 1, fromHeight)
      }
    };
  }
  const height = heightOf(chain, query);
  if (path === '/v1/waves/import') {
    const completed = height >= doneHeight;
    return one(chain, path, height, {
      started: true,
      completed,
      doneHeight: completed ? doneHeight : null
    });
  }
  if (parts[0] !== 'v1') return notFound(chain, path, height);
  const [, kind, objectId, sub, subId] = parts;
  if (parts.length === 2) {
    if (kind === 'groups') {
      return page(chain, height, await chain.listGroups(after, height));
    }
    if (kind === 'waves') {
      return page(chain, height, await chain.listWaves(after, height));
    }
    if (kind === 'decisions') {
      return page(chain, height, await chain.listDecisions(after, height));
    }
    return notFound(chain, path, height);
  }
  if (parts.length === 3) {
    const read: Record<string, (id: string, at: number) => Promise<unknown>> = {
      groups: (x, at) => chain.group(x, at),
      waves: (x, at) => chain.wave(x, at),
      decisions: (x, at) => chain.decision(x, at),
      entries: (x, at) => chain.entry(x, at),
      polls: (x, at) => chain.poll(x, at)
    };
    const reader = read[kind];
    if (!reader) return notFound(chain, path, height);
    return one(
      chain,
      path,
      height,
      (await reader(objectId, height)) as ChainObject | null
    );
  }
  if (kind === 'waves' && sub === 'roles') {
    return all(chain, path, height, await chain.waveRoles(objectId, height));
  }
  if (kind === 'waves' && sub === 'polls') {
    return all(chain, path, height, await chain.wavePolls(objectId, height));
  }
  if (kind === 'waves' && sub === 'rep' && subId === 'ratings') {
    return all(chain, path, height, await chain.waveRep(objectId, height));
  }
  if (kind === 'decisions' && sub === 'entries') {
    return page(
      chain,
      height,
      await chain.decisionEntries(objectId, after, height)
    );
  }
  if (kind === 'decisions' && sub === 'results' && subId !== undefined) {
    return one(
      chain,
      path,
      height,
      await chain.result(objectId, Number(subId), height)
    );
  }
  if (kind === 'decisions' && sub === 'results') {
    return all(
      chain,
      path,
      height,
      await chain.decisionResults(objectId, height)
    );
  }
  if (kind === 'decisions' && sub === 'leaderboard') {
    return one(
      chain,
      path,
      height,
      await chain.decisionLeaderboard(objectId, height)
    );
  }
  if (kind === 'entries' && sub === 'votes') {
    return all(chain, path, height, await chain.entryVotes(objectId, height));
  }
  return notFound(chain, path, height);
}

/** Serves the world on 127.0.0.1 (a free port unless `port` names one). */
export async function startGatewayWorld(
  world: WavesGatewayWorld = buildWavesGatewayWorld(),
  port = 0
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const reply = (answer: Answer) => {
      response.writeHead(answer.status, {
        'content-type': 'application/json'
      });
      response.end(JSON.stringify(answer.json));
    };
    if (request.method !== 'GET') {
      reply({ status: 405, json: { error: 'read only' } });
      return;
    }
    answerGatewayRequest(world, request.url ?? '/').then(reply, (error) =>
      reply(
        error instanceof ChainGatewayError && error.status !== null
          ? {
              status: error.status,
              json: { error: { code: error.code, message: error.message } }
            }
          : { status: 500, json: { error: String(error) } }
      )
    );
  });
  let url: string;
  if (port) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    url = `http://127.0.0.1:${port}`;
  } else {
    url = (await listenLoopback(server)).url;
  }
  return { url, close: () => closeServer(server) };
}

// `node ... gateway-world.ts [port]`: serves the world until stopped, for a
// recording run.
if (require.main === module) {
  startGatewayWorld(buildWavesGatewayWorld(), Number(process.argv[2] ?? 0))
    .then(({ url }) => {
      // eslint-disable-next-line no-console
      console.log(`waves gateway world at ${url}`);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error);
      process.exit(1);
    });
}
