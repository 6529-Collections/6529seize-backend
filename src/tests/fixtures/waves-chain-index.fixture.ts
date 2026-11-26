import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import {
  ChainFeedBlock,
  ChainFeedPage
} from '@/chain-gateway/chain-gateway.types';
import {
  ChainObject,
  ChainPage,
  WavesChainApi,
  WavesChainHead,
  WavesImportState
} from '@/waves-chain-index/waves-chain-index.api';
import {
  EMPTY_INDEX_STATE,
  INDEX_TABLES,
  IndexTableName,
  MAX_READ_EVENTS,
  RowStamp,
  WavesChainIndexDb,
  WavesChainIndexState
} from '@/waves-chain-index/waves-chain-index.db';
import {
  ClaimBuild,
  ClaimBuildMessage
} from '@/waves-chain-index/waves-chain-index.claims';
import {
  ballotKey,
  ChainEvent,
  eventCursor,
  EventCursorError,
  ObjectInfo,
  parseEventCursor,
  ScanState,
  StoredBallot,
  StoredVote,
  voteKey
} from '@/waves-chain-index/waves-chain-index.events';
import { VoteChange } from '@/waves-chain-index/waves-chain-index.feed';
import { hasKeys, IndexRow } from '@/waves-chain-index/waves-chain-index.rows';

/**
 * An in-memory chain and index for the index's tests. The chain keeps its
 * state at every height and answers a read at the height it is pinned to,
 * with the time of that height's block; every change is a new block with
 * the feed records the chain would write, their fields as the node gives
 * them.
 */

export const id = (n: number | string) =>
  `0x${String(n).padStart(64, '0')}`.toLowerCase();

export class FakeClock {
  t = 1_764_000_000_000;
  now = () => this.t;
}

type FeedRecord = {
  family: string;
  keyFields: Record<string, unknown>;
  /** null: the record was deleted. */
  valueFields?: Record<string, unknown> | null;
  /** A record the node could not decode: value set, fields null. */
  undecodable?: boolean;
};

interface ChainState {
  groups: Map<string, ChainObject>;
  waves: Map<string, ChainObject>;
  /** waveId -> grants (expiresAt 0: no expiry) */
  roles: Map<string, ChainObject[]>;
  rep: Map<string, ChainObject[]>;
  polls: Map<string, ChainObject>;
  decisions: Map<string, ChainObject>;
  entries: Map<string, ChainObject>;
  /** decision or poll id -> results */
  results: Map<string, ChainObject[]>;
  /** entryId -> voter -> vote */
  votes: Map<string, Map<string, ChainObject>>;
  /** pollId -> cluster -> { selection, version } */
  ballots: Map<string, Map<string, ChainObject>>;
}

function emptyState(): ChainState {
  return {
    groups: new Map(),
    waves: new Map(),
    roles: new Map(),
    rep: new Map(),
    polls: new Map(),
    decisions: new Map(),
    entries: new Map(),
    results: new Map(),
    votes: new Map(),
    ballots: new Map()
  };
}

// The chain's record fields (validator chain-state records.rs) for the
// fake's objects: enumerations as codes, 64-bit values as decimal text.
const CODES = {
  origin: { native: 1, legacy: 2 },
  entry: { active: 1, winner: 2, withdrawn: 3, disqualified: 4 },
  result: { counting: 0, skipped: 1, decided: 2, cancelled: 3 },
  stage: { none: 0, scoring: 1, final: 3 },
  decision: { draft: 1, published: 2, ended: 3, archived: 4 },
  open: { open: 1, closed: 2 }
};

function code(names: Record<string, number>, name: unknown): number {
  return names[String(name)] ?? 0;
}

/** A record's key as text that sorts about as its key bytes do. */
function recordKey(keyFields: Record<string, unknown>): string {
  return Object.values(keyFields)
    .map((v) =>
      typeof v === 'number' ? String(v).padStart(10, '0') : String(v)
    )
    .join('|');
}

function groupFields(group: ChainObject): ChainObject {
  return {
    version: group.version,
    controller: group.controller,
    visibility: 1,
    activeFrom: '0',
    origin: code(CODES.origin, group.origin)
  };
}

function groupDefFields(group: ChainObject, height: number): ChainObject {
  return {
    defHash: id(0),
    predicateMode: 1,
    clauses: [],
    includes: group.includes ?? [],
    excludes: [],
    storedIncludes: 0,
    storedExcludes: 0,
    activationHeight: String(height)
  };
}

function waveFields(wave: ChainObject): ChainObject {
  return {
    version: wave.version,
    controller: wave.controller,
    type: 1,
    status: code(CODES.open, wave.status),
    readGroup: wave.readGroup,
    postGroup: wave.postGroup,
    adminGroup: wave.adminGroup,
    policyVersion: wave.policyVersion,
    policyHash: id(0),
    metadataCid: '0x',
    decisions: wave.decisions ?? 0,
    origin: code(CODES.origin, wave.origin)
  };
}

function decisionFields(decision: ChainObject): ChainObject {
  return {
    waveId: decision.waveId,
    configVersion: 1,
    status: code(CODES.decision, decision.status),
    frozen: false,
    origin: code(CODES.origin, decision.origin),
    config: decision.config ?? {},
    nextOccurrence: 1,
    nextResultTime: String(decision.nextResultTime ?? 0),
    phase: decision.phase === 'settling' ? 2 : 1
  };
}

function entryFields(entry: ChainObject): ChainObject {
  return {
    decisionId: entry.decisionId,
    author: entry.author,
    version: entry.version ?? 1,
    origin: code(CODES.origin, entry.origin),
    manifestHash: entry.manifestHash ?? id(0),
    contentCid: '0x',
    status: code(CODES.entry, entry.status),
    total: String(entry.total ?? '0'),
    integral: '0',
    tLast: String(entry.tLast ?? 0),
    createdMs: String(entry.createdMs ?? 0),
    resultTime: String(entry.resultTime ?? 0),
    rank: entry.rank ?? 0
  };
}

function resultFields(result: ChainObject, height: number): ChainObject {
  const final = result.stage === 'final';
  const winners = (result.winners ?? []) as ChainObject[];
  return {
    occurrence: result.occurrence ?? 0,
    status: code(CODES.result, result.status),
    pauseId: 0,
    winners: winners.map((w) => ({
      entryId: w.entryId,
      rank: w.rank,
      score: String(w.score ?? '0'),
      lastIncreaseTime: '0',
      lastIncreaseHeight: '0',
      lastIncreaseIndex: 0
    })),
    outcomeHash: id(0),
    settledHeight: String(final ? height : 0),
    stage: code(CODES.stage, result.stage),
    next: 0,
    origin: code(CODES.origin, result.origin ?? 'native')
  };
}

function pollFields(poll: ChainObject): ChainObject {
  return {
    waveId: poll.waveId,
    optionCount: 3,
    maxChoices: 2,
    closeTime: String(poll.closeTime ?? 0),
    status: code(CODES.open, poll.status),
    ballots: poll.ballots ?? 0,
    tallies: poll.tallies ?? [],
    origin: code(CODES.origin, poll.origin)
  };
}

function byId(field: string) {
  return (a: ChainObject, b: ChainObject) =>
    String(a[field]).localeCompare(String(b[field]));
}

export class FakeChain implements WavesChainApi {
  height = 100;
  completed = true;
  /** The import's start (startMs) the import's answer gives. */
  importStartedAt: number | null = 1_763_990_000_000;
  network: string | null = 'net-1';
  /** Feed heights below this answer `gone`. */
  goneBelow = 0;
  /** `gone` answers left before the feed answers again (a flaky node). */
  goneTimes = 0;
  /** The finalized height trails the feed's by this much (a newer node). */
  lag = 0;
  /** The head comes with no block time (none could be read). */
  timeUnknown = false;
  /** Each call moves the wall clock by this much. */
  callMs = 0;
  calls = 0;
  failOn: string | null = null;
  /** Page size of the lists. */
  pageSize = 2;
  readonly blocks: ChainFeedBlock[] = [];
  /** Each voter's votes in a decision, in VoteAt order (`voter:decision`). */
  private readonly voteLists = new Map<string, string[]>();
  /** VoterBudget by `voter:decision`, and VoterAt's order of them. */
  private readonly budgets = new Map<string, ChainObject>();
  private readonly voterAt: string[] = [];
  /** A decision's ACTIVE entries in DecisionEntryAt order. */
  private readonly entryLists = new Map<string, string[]>();
  readonly voteScan = {
    voters: 0,
    scanDay: 0,
    scanning: 0,
    scanNext: 0,
    finishedDay: 0
  };
  /** The reduction under way. */
  voteReduce: ChainObject | null = null;
  /** The state as of now; `commit` keeps a copy at the new height. */
  readonly live: ChainState = emptyState();
  private readonly snapshots = new Map<number, ChainState>();
  private readonly times = new Map<number, number>();

  constructor(private readonly clock: FakeClock) {
    this.snapshots.set(this.height, structuredClone(this.live));
    this.times.set(this.height, clock.t);
  }

  private call(name: string) {
    this.calls++;
    this.clock.t += this.callMs;
    if (this.failOn === name) throw new Error(`${name} failed`);
  }

  private stateAt(at: number): ChainState {
    if (at > this.height) throw new Error(`no height ${at} yet`);
    for (let h = at; h >= 0; h--) {
      const state = this.snapshots.get(h);
      if (state) return state;
    }
    return emptyState();
  }

  private timeAt(at: number): number {
    for (let h = at; h >= 0; h--) {
      const time = this.times.get(h);
      if (time !== undefined) return time;
    }
    return 0;
  }

  // ------------------------------------------------------------ changes

  /**
   * A new block, a second later than the last, holding these records as
   * the node's feed gives them: one record a key (the last write), in
   * family and key order.
   */
  commit(records: FeedRecord[]) {
    this.clock.t += 1000;
    this.height++;
    this.snapshots.set(this.height, structuredClone(this.live));
    this.times.set(this.height, this.clock.t);
    const byKey = new Map<string, FeedRecord>();
    for (const r of records) {
      byKey.set(`${r.family}|${recordKey(r.keyFields)}`, r);
    }
    const ordered = Array.from(byKey.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, r]) => r);
    this.blocks.push({
      height: this.height,
      slot: this.height,
      root: id(0),
      time: this.clock.t,
      records: ordered.map((r) => ({
        family: r.family,
        name: 'r',
        key: '0x',
        value: r.valueFields === null ? null : '0x01',
        keyFields: r.keyFields,
        valueFields: r.undecodable
          ? null
          : r.valueFields === undefined
            ? {}
            : r.valueFields
      }))
    });
  }

  /** The next block's height and time: what `commit` gives it. */
  private get nextHeight() {
    return this.height + 1;
  }

  private get nextTime() {
    return this.clock.t + 1000;
  }

  /** Time passes: empty blocks up to `ms` later. */
  tick(ms: number) {
    this.clock.t += ms - 1000;
    this.commit([]);
  }

  /** GROUP_CREATE, or GROUP_REPLACE when the group exists. */
  putGroup(groupId: string, fields: ChainObject = {}) {
    const old = this.live.groups.get(groupId);
    const group: ChainObject = {
      groupId,
      version: old ? Number(old.version) + 1 : 1,
      controller: id('c0'),
      origin: 'legacy',
      ...fields
    };
    this.live.groups.set(groupId, group);
    this.commit([
      {
        family: '0x0401',
        keyFields: { groupId },
        valueFields: groupFields(group)
      },
      {
        family: '0x0402',
        keyFields: { groupId, version: group.version },
        valueFields: groupDefFields(group, this.nextHeight)
      }
    ]);
  }

  /**
   * WAVE_CREATE (with the controller's admin grant, granted by `creator`),
   * or WAVE_POLICY_REPLACE when the wave exists: a new policy version when
   * its groups change.
   */
  putWave(waveId: string, fields: ChainObject = {}, creator = id('c1')) {
    const old = this.live.waves.get(waveId);
    const wave: ChainObject = {
      waveId,
      legacyId: null,
      status: 'open',
      membersOnly: false,
      readGroup: { groupId: id(0), version: 0 },
      postGroup: { groupId: id(0), version: 0 },
      adminGroup: { groupId: id(0), version: 0 },
      decisions: 0,
      origin: 'native',
      controller: id('c0'),
      version: 0,
      policyVersion: 0,
      ...(old ?? {}),
      ...fields
    };
    const groupsMoved =
      !old ||
      ['readGroup', 'postGroup', 'adminGroup'].some(
        (g) => JSON.stringify(old[g]) !== JSON.stringify(wave[g])
      );
    wave.version = Number(old?.version ?? 0) + 1;
    if (groupsMoved) wave.policyVersion = Number(old?.policyVersion ?? 0) + 1;
    this.live.waves.set(waveId, wave);
    const records: FeedRecord[] = [
      { family: '0x0501', keyFields: { waveId }, valueFields: waveFields(wave) }
    ];
    if (groupsMoved) {
      records.push({
        family: '0x0502',
        keyFields: { waveId, version: wave.policyVersion },
        valueFields: {
          readGroup: wave.readGroup,
          postGroup: wave.postGroup,
          adminGroup: wave.adminGroup,
          activationHeight: String(this.nextHeight)
        }
      });
    }
    if (!old) {
      records.push({
        family: '0x0403',
        keyFields: { scopeId: waveId, role: 1, principalId: wave.controller },
        valueFields: { version: 1, grantedBy: creator, expiresAt: '0' }
      });
    }
    this.commit(records);
  }

  putRole(waveId: string, principalId: string, fields: ChainObject = {}) {
    const list = (this.live.roles.get(waveId) ?? []).filter(
      (r) => r.principalId !== principalId
    );
    list.push({
      role: 'admin',
      principalId,
      version: 1,
      expiresAt: 0,
      ...fields
    });
    this.live.roles.set(waveId, list);
    this.commit([
      {
        family: '0x0403',
        keyFields: { scopeId: waveId, role: 'admin', principalId }
      }
    ]);
  }

  rate(waveId: string, rater: string, value: number) {
    const list = (this.live.rep.get(waveId) ?? []).filter(
      (r) => r.rater !== rater
    );
    if (value !== 0) {
      list.push({
        rater,
        waveId,
        category: { id: id('c'), name: 'Cat' },
        value,
        updatedHeight: this.height + 1
      });
    }
    this.live.rep.set(waveId, list);
    this.commit([
      {
        family: '0x0701',
        keyFields: {
          rater,
          matter: 3,
          targetKind: 2,
          target: waveId,
          category: id('c')
        }
      }
    ]);
  }

  putPoll(pollId: string, waveId: string, fields: ChainObject = {}) {
    this.live.polls.set(pollId, {
      pollId,
      waveId,
      status: 'open',
      closeTime: 5,
      origin: 'native',
      ballots: 0,
      tallies: [0, 0, 0],
      ...fields
    });
    this.commit([
      {
        family: '0x060b',
        keyFields: { pollId },
        valueFields: pollFields(this.live.polls.get(pollId)!)
      },
      { family: '0x0613', keyFields: { waveId } }
    ]);
  }

  /** A poll closes: Poll, PollCount and its Result (under the poll id). */
  closePoll(pollId: string) {
    const poll = this.live.polls.get(pollId) as ChainObject;
    this.live.polls.set(pollId, { ...poll, status: 'closed' });
    const result = {
      id: pollId,
      resultTime: poll.closeTime,
      status: 'decided',
      stage: 'final',
      occurrence: 0,
      winners: []
    };
    this.live.results.set(pollId, [result]);
    this.commit([
      {
        family: '0x060b',
        keyFields: { pollId },
        valueFields: pollFields(this.live.polls.get(pollId)!)
      },
      { family: '0x0613', keyFields: { waveId: poll.waveId } },
      {
        family: '0x060a',
        keyFields: { id: pollId, D: String(poll.closeTime) },
        valueFields: resultFields(result, this.nextHeight)
      }
    ]);
  }

  /**
   * POLL_BALLOT_SET: cluster `cid`'s ballot moves to `selection` (each
   * given one is set in turn in the one block), the poll's tallies with it.
   */
  ballot(pollId: string, cid: string, ...selections: number[]) {
    const ballots = this.live.ballots.get(pollId) ?? new Map();
    const poll = this.live.polls.get(pollId) as ChainObject;
    const tallies = [...((poll.tallies as number[]) ?? [0, 0, 0])];
    let count = Number(poll.ballots ?? 0);
    let version = 0;
    for (const selection of selections) {
      const old = ballots.get(cid);
      version = Number(old?.version ?? 0) + 1;
      if (!old) count++;
      for (let o = 0; o < tallies.length; o++) {
        tallies[o] +=
          ((selection >> o) & 1) - ((Number(old?.selection ?? 0) >> o) & 1);
      }
      ballots.set(cid, { selection, version });
    }
    this.live.ballots.set(pollId, ballots);
    this.live.polls.set(pollId, { ...poll, ballots: count, tallies });
    this.commit([
      {
        family: '0x060b',
        keyFields: { pollId },
        valueFields: pollFields(this.live.polls.get(pollId)!)
      },
      {
        family: '0x060c',
        keyFields: { pollId, cid },
        valueFields: { selection: selections.at(-1), version }
      }
    ]);
  }

  putDecision(decisionId: string, waveId: string, fields: ChainObject = {}) {
    this.live.decisions.set(decisionId, {
      decisionId,
      waveId,
      status: 'published',
      kind: 'rank',
      counted: false,
      phase: 'open',
      nextResultTime: 0,
      origin: 'native',
      config: { creditScope: 1, creditSource: 1 },
      ...fields
    });
    this.commit([this.decisionRecord(decisionId)]);
  }

  private decisionRecord(decisionId: string): FeedRecord {
    return {
      family: '0x0601',
      keyFields: { decisionId },
      valueFields: decisionFields(this.live.decisions.get(decisionId)!)
    };
  }

  private entryRecord(entryId: string): FeedRecord {
    return {
      family: '0x0603',
      keyFields: { entryId },
      valueFields: entryFields(this.live.entries.get(entryId)!)
    };
  }

  /** The decision's ACTIVE entries in list order (DecisionEntryAt). */
  private activeList(decisionId: string): string[] {
    let list = this.entryLists.get(decisionId);
    if (!list) {
      list = [];
      this.entryLists.set(decisionId, list);
    }
    return list;
  }

  /**
   * Entry `entryId` leaves ACTIVE (entry::leave): the decision's last
   * ACTIVE entry moves into its list place (its Entry written), the
   * decision is written.
   */
  private leave(
    entryId: string,
    status: string,
    records: FeedRecord[],
    fields: ChainObject = {}
  ) {
    const entry = this.live.entries.get(entryId) as ChainObject;
    const decisionId = entry.decisionId as string;
    const list = this.activeList(decisionId);
    const i = list.indexOf(entryId);
    const last = list.length - 1;
    if (i >= 0 && i < last) {
      const moved = list[last];
      list[i] = moved;
      this.live.entries.set(moved, {
        ...(this.live.entries.get(moved) as ChainObject),
        listIndex: i
      });
      records.push(this.entryRecord(moved));
      records.push({
        family: '0x0610',
        keyFields: { decisionId, i },
        valueFields: { entryId: moved }
      });
    }
    if (i >= 0) {
      list.pop();
      records.push({
        family: '0x0610',
        keyFields: { decisionId, i: last },
        valueFields: null
      });
    }
    this.live.entries.set(entryId, {
      ...entry,
      ...fields,
      status,
      version: Number(entry.version ?? 1) + 1
    });
    records.push(this.entryRecord(entryId));
    records.push(this.decisionRecord(decisionId));
  }

  /**
   * SUBMISSION_CREATE for a new entry (created at the block's time), or an
   * entry's change; a status other than active leaves ACTIVE
   * (SUBMISSION_WITHDRAW for withdrawn).
   */
  putEntry(entryId: string, decisionId: string, fields: ChainObject = {}) {
    const old = this.live.entries.get(entryId);
    if (old && old.status === 'active' && fields.status !== undefined) {
      if (fields.status !== 'active') {
        const records: FeedRecord[] = [];
        this.leave(entryId, fields.status as string, records, fields);
        this.commit(records);
        return;
      }
    }
    const list = this.activeList(decisionId);
    const entry: ChainObject = {
      entryId,
      decisionId,
      author: id('a1'),
      status: 'active',
      total: '0',
      tLast: 0,
      origin: 'native',
      createdMs: this.nextTime,
      manifestHash: id(`fe${entryId.slice(-8)}`),
      version: 1,
      listIndex: list.length,
      ...(old ?? {}),
      ...fields
    };
    if (!old && entry.status === 'active') list.push(entryId);
    this.live.entries.set(entryId, entry);
    this.commit([this.entryRecord(entryId)]);
  }

  // ---------------------------------------------------- votes and the scan

  private budgetKey(voter: string, decisionId: string) {
    return `${voter}:${decisionId}`;
  }

  private voteScanRecord(records: FeedRecord[]) {
    records.push({
      family: '0x0612',
      keyFields: {},
      valueFields: {
        voters: this.voteScan.voters,
        scanDay: this.voteScan.scanDay,
        scanning: this.voteScan.scanning,
        scanNext: this.voteScan.scanNext,
        finishedDay: this.voteScan.finishedDay
      }
    });
  }

  /** The voter's budget in the decision, made on its first vote. */
  private budget(
    voter: string,
    decisionId: string,
    records: FeedRecord[]
  ): ChainObject {
    const key = this.budgetKey(voter, decisionId);
    let budget = this.budgets.get(key);
    if (!budget) {
      budget = {
        spent: 0,
        activeVotes: 0,
        walkedHeight: this.nextHeight,
        scanIndex: this.voterAt.length,
        peak: 0
      };
      this.budgets.set(key, budget);
      records.push({
        family: '0x060f',
        keyFields: { i: this.voterAt.length },
        valueFields: { voter, decisionId }
      });
      this.voterAt.push(key);
      this.voteScan.voters = this.voterAt.length;
      this.voteScanRecord(records);
    }
    return budget;
  }

  /** budget_store: a budget holding no vote leaves VoterAt and goes. */
  private storeBudget(
    voter: string,
    decisionId: string,
    records: FeedRecord[]
  ) {
    const key = this.budgetKey(voter, decisionId);
    const budget = this.budgets.get(key) as ChainObject;
    const budgetKey = { voter, decisionId };
    if (Number(budget.activeVotes) > 0) {
      records.push({
        family: '0x0609',
        keyFields: budgetKey,
        valueFields: {
          spent: String(budget.spent),
          activeVotes: budget.activeVotes,
          walkedHeight: String(budget.walkedHeight),
          scanIndex: budget.scanIndex,
          peak: String(budget.peak)
        }
      });
      return;
    }
    const i = this.voterAt.indexOf(key);
    const last = this.voterAt.length - 1;
    if (i < last) {
      const moved = this.voterAt[last];
      this.voterAt[i] = moved;
      const [movedVoter, movedDecision] = moved.split(':');
      records.push({
        family: '0x060f',
        keyFields: { i },
        valueFields: { voter: movedVoter, decisionId: movedDecision }
      });
    }
    this.voterAt.pop();
    records.push({
      family: '0x060f',
      keyFields: { i: last },
      valueFields: null
    });
    this.voteScan.voters = this.voterAt.length;
    this.voteScan.scanNext = Math.min(this.voteScan.scanNext, last);
    this.voteScanRecord(records);
    this.budgets.delete(key);
    records.push({ family: '0x0609', keyFields: budgetKey, valueFields: null });
  }

  private voteList(voter: string, decisionId: string): string[] {
    const key = this.budgetKey(voter, decisionId);
    let list = this.voteLists.get(key);
    if (!list) {
      list = [];
      this.voteLists.set(key, list);
    }
    return list;
  }

  private voteRecord(
    entryId: string,
    voter: string,
    undecodable = false
  ): FeedRecord {
    const vote = this.live.votes.get(entryId)?.get(voter);
    const decisionId = (this.live.entries.get(entryId) as ChainObject)
      .decisionId;
    return {
      family: '0x0607',
      keyFields: { voter, decisionId, entryId },
      valueFields: vote
        ? {
            value: String(vote.value),
            updatedHeight: String(vote.updatedHeight),
            index: vote.index
          }
        : null,
      undecodable
    };
  }

  private setVote(entryId: string, voter: string, vote: ChainObject | null) {
    const votes =
      this.live.votes.get(entryId) ?? new Map<string, ChainObject>();
    if (vote) votes.set(voter, vote);
    else votes.delete(voter);
    this.live.votes.set(entryId, votes);
  }

  /**
   * votes::remove: the vote goes, the voter's last vote moves into its
   * place (its Vote written with the new index, VoteAt with it).
   */
  private removeVote(entryId: string, voter: string, records: FeedRecord[]) {
    const decisionId = (this.live.entries.get(entryId) as ChainObject)
      .decisionId as string;
    const list = this.voteList(voter, decisionId);
    const i = list.indexOf(entryId);
    const last = list.length - 1;
    this.setVote(entryId, voter, null);
    records.push(this.voteRecord(entryId, voter));
    if (i < last) {
      const moved = list[last];
      list[i] = moved;
      const vote = this.live.votes.get(moved)?.get(voter) as ChainObject;
      this.setVote(moved, voter, { ...vote, index: i });
      records.push(this.voteRecord(moved, voter));
      records.push({
        family: '0x060e',
        keyFields: { voter, decisionId, i },
        valueFields: { entryId: moved }
      });
    }
    list.pop();
    records.push({
      family: '0x060e',
      keyFields: { voter, decisionId, i: last },
      valueFields: null
    });
    const budget = this.budgets.get(this.budgetKey(voter, decisionId));
    if (budget) budget.activeVotes = list.length;
  }

  /** The entry's total is its votes' sum, changed in the next block. */
  private retotal(entryId: string, records: FeedRecord[]) {
    const entry = this.live.entries.get(entryId) as ChainObject;
    const total = Array.from(
      this.live.votes.get(entryId)?.values() ?? []
    ).reduce((sum, v) => sum + Number(v.value), 0);
    this.live.entries.set(entryId, {
      ...entry,
      total: String(total),
      tLast: this.nextTime
    });
    records.push(this.entryRecord(entryId));
  }

  /** VOTE_SET: the voter's vote on the entry becomes `value` (0 removes it). */
  vote(entryId: string, voter: string, value: number, undecodable = false) {
    const records: FeedRecord[] = [];
    const entry = this.live.entries.get(entryId) as ChainObject;
    const decisionId = entry.decisionId as string;
    const old = this.live.votes.get(entryId)?.get(voter);
    const budget = this.budget(voter, decisionId, records);
    const list = this.voteList(voter, decisionId);
    budget.spent =
      Number(budget.spent) -
      Math.abs(Number(old?.value ?? 0)) +
      Math.abs(value);
    budget.peak = Math.max(Number(budget.peak), Math.abs(value));
    if (value === 0) {
      this.removeVote(entryId, voter, records);
    } else {
      if (!old) {
        list.push(entryId);
        records.push({
          family: '0x060e',
          keyFields: { voter, decisionId, i: list.length - 1 },
          valueFields: { entryId }
        });
      }
      this.setVote(entryId, voter, {
        voter,
        decisionId,
        entryId,
        value: String(value),
        updatedHeight: this.nextHeight,
        index: list.indexOf(entryId)
      });
      records.push(this.voteRecord(entryId, voter, undecodable));
      budget.activeVotes = list.length;
    }
    this.retotal(entryId, records);
    this.storeBudget(voter, decisionId, records);
    this.commit(records);
  }

  /**
   * One block of the daily vote scan: each reduction cuts the voter's votes
   * in the decision (0 removes one, moving the voter's last vote into its
   * place; the value moves, `updatedHeight` stays) and ends in the block,
   * but the last one when `underWay`. VoteReduce is in the block only when
   * it differs from before the block (a reduction that starts and ends in
   * the block leaves none).
   */
  scan(
    reductions: {
      voter: string;
      decisionId: string;
      cuts: { entryId: string; value: number }[];
    }[],
    underWay = false
  ) {
    const records: FeedRecord[] = [];
    const before = this.voteReduce;
    this.voteScan.scanning = 1;
    this.voteScan.scanDay = this.voteScan.finishedDay + 1;
    reductions.forEach(({ voter, decisionId, cuts }, n) => {
      this.voteScan.scanNext = Math.max(0, this.voteScan.scanNext - 1);
      const budget = this.budgets.get(
        this.budgetKey(voter, decisionId)
      ) as ChainObject;
      for (const { entryId, value } of cuts) {
        const vote = this.live.votes.get(entryId)?.get(voter) as ChainObject;
        budget.spent =
          Number(budget.spent) - Math.abs(Number(vote.value)) + Math.abs(value);
        if (value === 0) this.removeVote(entryId, voter, records);
        else {
          this.setVote(entryId, voter, { ...vote, value: String(value) });
          records.push(this.voteRecord(entryId, voter));
        }
        this.retotal(entryId, records);
      }
      const last = n === reductions.length - 1;
      this.voteReduce =
        last && underWay ? { voter, decisionId, phase: 2, next: 0 } : null;
      if (this.voteReduce) {
        records.push({
          family: '0x0609',
          keyFields: { voter, decisionId },
          valueFields: { ...budget, spent: String(budget.spent) }
        });
      } else {
        this.storeBudget(voter, decisionId, records);
      }
    });
    this.voteScanRecord(records);
    if (JSON.stringify(before) !== JSON.stringify(this.voteReduce)) {
      records.push({
        family: '0x0611',
        keyFields: {},
        valueFields: this.voteReduce
          ? {
              ...this.voteReduce,
              num: '1',
              den: '2',
              startHeight: String(this.nextHeight)
            }
          : null
      });
    }
    this.commit(records);
  }

  /** The reduction under way ends in a block of its own; the scan goes on. */
  endReduction(
    cuts: { entryId: string; value: number }[] = [],
    finish = false
  ) {
    const reducing = this.voteReduce as ChainObject;
    const records: FeedRecord[] = [];
    const voter = reducing.voter as string;
    const decisionId = reducing.decisionId as string;
    const budget = this.budgets.get(
      this.budgetKey(voter, decisionId)
    ) as ChainObject;
    for (const { entryId, value } of cuts) {
      const vote = this.live.votes.get(entryId)?.get(voter) as ChainObject;
      budget.spent =
        Number(budget.spent) - Math.abs(Number(vote.value)) + Math.abs(value);
      if (value === 0) this.removeVote(entryId, voter, records);
      else {
        this.setVote(entryId, voter, { ...vote, value: String(value) });
        records.push(this.voteRecord(entryId, voter));
      }
      this.retotal(entryId, records);
    }
    this.storeBudget(voter, decisionId, records);
    this.voteReduce = null;
    records.push({ family: '0x0611', keyFields: {}, valueFields: null });
    if (finish) {
      this.voteScan.finishedDay = this.voteScan.scanDay;
      this.voteScan.scanDay = 0;
      this.voteScan.scanning = 0;
      this.voteScan.scanNext = 0;
      this.voteScanRecord(records);
    }
    this.commit(records);
  }

  /** The scan's last check finds no budget left: it finishes. */
  finishScan() {
    const records: FeedRecord[] = [];
    this.voteScan.finishedDay = this.voteScan.scanDay;
    this.voteScan.scanDay = 0;
    this.voteScan.scanning = 0;
    this.voteScan.scanNext = 0;
    this.voteScanRecord(records);
    this.commit(records);
  }

  /**
   * A cut by the scan, the voter's reduction still under way at the end of
   * the block (VoteReduce names it): `scan` with one reduction.
   */
  cut(entryId: string, voter: string, value: number) {
    const decisionId = (this.live.entries.get(entryId) as ChainObject)
      .decisionId as string;
    this.scan([{ voter, decisionId, cuts: [{ entryId, value }] }], true);
  }

  /**
   * Votes released (votes::release, by a walk or VOTE_RELEASE): removed,
   * each entry's total as it was.
   */
  release(entryId: string, ...voters: string[]) {
    const records: FeedRecord[] = [];
    const decisionId = (this.live.entries.get(entryId) as ChainObject)
      .decisionId as string;
    for (const voter of voters) {
      const vote = this.live.votes.get(entryId)?.get(voter) as ChainObject;
      const budget = this.budgets.get(
        this.budgetKey(voter, decisionId)
      ) as ChainObject;
      budget.spent = Number(budget.spent) - Math.abs(Number(vote.value));
      this.removeVote(entryId, voter, records);
      this.storeBudget(voter, decisionId, records);
    }
    this.commit(records);
  }

  putResult(decisionId: string, resultTime: number, fields: ChainObject = {}) {
    const list = (this.live.results.get(decisionId) ?? []).filter(
      (r) => r.resultTime !== resultTime
    );
    const result: ChainObject = {
      id: decisionId,
      resultTime,
      status: 'decided',
      stage: 'final',
      origin: 'native',
      ...fields
    };
    list.push(result);
    list.sort((a, b) => Number(a.resultTime) - Number(b.resultTime));
    this.live.results.set(decisionId, list);
    this.commit([
      {
        family: '0x060a',
        keyFields: { id: decisionId, D: String(resultTime) },
        valueFields: resultFields(result, this.nextHeight)
      }
    ]);
  }

  /**
   * A count closes: the result is final with these winners, each leaves
   * ACTIVE as a winner, and the decision is written.
   */
  settle(
    decisionId: string,
    resultTime: number,
    winners: string[],
    occurrence = 1,
    // null: the answer names no origin.
    origin: 'native' | 'legacy' | null = 'native',
    status = winners.length ? 'decided' : 'skipped'
  ) {
    const result: ChainObject = {
      id: decisionId,
      resultTime,
      occurrence,
      status,
      stage: 'final',
      ...(origin === null ? {} : { origin }),
      // The block it goes final in, as the API gives it.
      settledHeight: this.nextHeight,
      winners: winners.map((entryId, i) => ({
        entryId,
        rank: i + 1,
        score: this.live.entries.get(entryId)?.total ?? '0'
      }))
    };
    this.live.results.set(decisionId, [
      ...(this.live.results.get(decisionId) ?? []).filter(
        (r) => r.resultTime !== resultTime
      ),
      result
    ]);
    const records: FeedRecord[] = [];
    winners.forEach((entryId, i) =>
      this.leave(entryId, 'winner', records, { resultTime, rank: i + 1 })
    );
    records.push({
      family: '0x060a',
      keyFields: { id: decisionId, D: String(resultTime) },
      valueFields: resultFields(result, this.nextHeight)
    });
    this.commit(records);
  }

  /** MODERATION_DECIDE: the entry is disqualified in its wave. */
  moderate(waveId: string, entryId: string, decidedBy: string) {
    const records: FeedRecord[] = [
      {
        family: '0x0506',
        keyFields: { scopeId: waveId, subjectId: entryId },
        valueFields: {
          action: 1,
          version: 1,
          policyVersion: 1,
          until: '0',
          decidedBy,
          reasonHash: id(0)
        }
      }
    ];
    this.leave(entryId, 'disqualified', records);
    this.commit(records);
  }

  // ------------------------------------------------------------ answers

  private waveAnswer(state: ChainState, wave: ChainObject): ChainObject {
    const openPolls = Array.from(state.polls.values()).filter(
      (p) => p.waveId === wave.waveId && p.status === 'open'
    ).length;
    return { ...wave, openPolls };
  }

  private decisionAnswer(decision: ChainObject, time: number): ChainObject {
    const next = Number(decision.nextResultTime);
    const due =
      decision.counted === true &&
      decision.status === 'published' &&
      next > 0 &&
      time >= next;
    return { ...decision, due };
  }

  private scoreOf(decision: ChainObject, entry: ChainObject, time: number) {
    if (decision.counted !== true) return String(entry.total);
    const at =
      decision.status === 'published'
        ? Math.min(time, Number(decision.nextResultTime) || time)
        : time;
    const held = Math.max(0, at - Number(entry.tLast));
    return String(Number(entry.total) * Math.floor(held / 1000));
  }

  private roleAnswer(grant: ChainObject, time: number): ChainObject {
    const expiresAt = Number(grant.expiresAt);
    return { ...grant, live: expiresAt === 0 || time < expiresAt };
  }

  private list(
    items: ChainObject[],
    field: string,
    after: string | null
  ): ChainPage<ChainObject> {
    const sorted = items
      .filter((item) => after === null || String(item[field]) > after)
      .sort(byId(field));
    const page = sorted.slice(0, this.pageSize);
    return {
      items: page,
      next:
        sorted.length > this.pageSize
          ? String(page[page.length - 1][field])
          : null
    };
  }

  // ------------------------------------------------------------ reads

  async head(): Promise<WavesChainHead> {
    this.call('head');
    const finalized = this.height - this.lag;
    return {
      finalizedHeight: finalized,
      finalizedTime: this.timeUnknown ? null : this.timeAt(finalized),
      network: this.network
    };
  }

  async importState(_at: number): Promise<WavesImportState | null> {
    this.call('importState');
    return { completed: this.completed, startedAt: this.importStartedAt };
  }

  async listGroups(after: string | null, at: number) {
    this.call('listGroups');
    return this.list(
      Array.from(this.stateAt(at).groups.values()),
      'groupId',
      after
    );
  }

  async listWaves(after: string | null, at: number) {
    this.call('listWaves');
    const state = this.stateAt(at);
    const page = this.list(Array.from(state.waves.values()), 'waveId', after);
    return {
      ...page,
      items: page.items.map((w) => this.waveAnswer(state, w))
    };
  }

  async listDecisions(after: string | null, at: number) {
    this.call('listDecisions');
    const page = this.list(
      Array.from(this.stateAt(at).decisions.values()),
      'decisionId',
      after
    );
    const time = this.timeAt(at);
    return {
      ...page,
      items: page.items.map((d) => this.decisionAnswer(d, time))
    };
  }

  async group(groupId: string, at: number) {
    this.call('group');
    return this.stateAt(at).groups.get(groupId) ?? null;
  }

  async wave(waveId: string, at: number) {
    this.call('wave');
    const state = this.stateAt(at);
    const wave = state.waves.get(waveId);
    return wave ? this.waveAnswer(state, wave) : null;
  }

  async decision(decisionId: string, at: number) {
    this.call('decision');
    const decision = this.stateAt(at).decisions.get(decisionId);
    return decision ? this.decisionAnswer(decision, this.timeAt(at)) : null;
  }

  /** The single-entry route adds the live score; the lists don't. */
  async entry(entryId: string, at: number) {
    this.call('entry');
    const state = this.stateAt(at);
    const entry = state.entries.get(entryId);
    if (!entry) return null;
    const decision = state.decisions.get(entry.decisionId as string)!;
    return {
      ...entry,
      score:
        entry.status === 'active'
          ? this.scoreOf(decision, entry, this.timeAt(at))
          : null
    };
  }

  async poll(pollId: string, at: number) {
    this.call('poll');
    const state = this.stateAt(at);
    const poll = state.polls.get(pollId);
    if (!poll) return null;
    return { ...poll, result: state.results.get(pollId)?.[0] ?? null };
  }

  /** The node doesn't check the id is a decision's: a poll's result too. */
  async result(id_: string, resultTime: number, at: number) {
    this.call('result');
    return (
      (this.stateAt(at).results.get(id_) ?? []).find(
        (r) => r.resultTime === resultTime
      ) ?? null
    );
  }

  async decisionLeaderboard(decisionId: string, at: number) {
    this.call('decisionLeaderboard');
    const state = this.stateAt(at);
    const decision = state.decisions.get(decisionId);
    if (!decision) return null;
    const time = this.timeAt(at);
    const counted = decision.counted === true;
    const rows = Array.from(state.entries.values())
      .filter((e) => e.decisionId === decisionId && e.status === 'active')
      .map((e) => ({
        entryId: e.entryId,
        total: e.total,
        score: this.scoreOf(decision, e, time)
      }))
      .sort(
        (a, b) =>
          Number(b.score) - Number(a.score) ||
          String(a.entryId).localeCompare(String(b.entryId))
      )
      .map((r, i) => ({ rank: i + 1, ...r }));
    return {
      decisionId,
      scoredAt:
        counted && decision.status === 'published'
          ? Math.min(time, Number(decision.nextResultTime) || time)
          : time,
      by: counted ? 'time_weighted_score' : 'total',
      count: rows.length,
      rows
    };
  }

  async waveRoles(waveId: string, at: number) {
    this.call('waveRoles');
    const state = this.stateAt(at);
    if (!state.waves.has(waveId)) return null;
    const time = this.timeAt(at);
    return (state.roles.get(waveId) ?? []).map((g) => this.roleAnswer(g, time));
  }

  async wavePolls(waveId: string, at: number) {
    this.call('wavePolls');
    const state = this.stateAt(at);
    if (!state.waves.has(waveId)) return null;
    return Array.from(state.polls.values())
      .filter((p) => p.waveId === waveId)
      .map((p) => ({
        ...p,
        result: state.results.get(String(p.pollId))?.[0] ?? null
      }));
  }

  async waveRep(waveId: string, at: number) {
    this.call('waveRep');
    const state = this.stateAt(at);
    return state.waves.has(waveId) ? [...(state.rep.get(waveId) ?? [])] : null;
  }

  async decisionEntries(decisionId: string, after: string | null, at: number) {
    this.call('decisionEntries');
    return this.list(
      Array.from(this.stateAt(at).entries.values()).filter(
        (e) => e.decisionId === decisionId
      ),
      'entryId',
      after
    );
  }

  async decisionResults(decisionId: string, at: number) {
    this.call('decisionResults');
    const state = this.stateAt(at);
    if (!state.decisions.has(decisionId)) return null;
    return [...(state.results.get(decisionId) ?? [])];
  }

  async entryVotes(entryId: string, at: number) {
    this.call('entryVotes');
    const state = this.stateAt(at);
    if (!state.entries.has(entryId)) return null;
    return Array.from(state.votes.get(entryId)?.values() ?? []).sort(
      byId('voter')
    );
  }

  async feed(from: number): Promise<ChainFeedPage> {
    this.call('feed');
    if (from < this.goneBelow || this.goneTimes > 0) {
      if (this.goneTimes > 0) this.goneTimes--;
      throw new ChainGatewayError('/v1/feed: gone', 410, 'gone', '/v1/feed');
    }
    const through = this.height;
    const blocks = this.blocks
      .filter((b) => b.height >= from && b.height <= through)
      .slice(0, 3);
    const last = blocks.length === 3 ? blocks[2].height : through;
    // Whole blocks only, as the client gives a page that ends at a block.
    return {
      from,
      through: last,
      blocks,
      next: last + 1,
      nextHeight: Math.max(last + 1, from),
      atHead: !blocks.length && last < from
    };
  }
}

/** A row of chain_claim_builds, as the fake keeps it. */
type FakeClaimBuild = Omit<ClaimBuild, 'status'> & {
  status: 'pending' | 'skipped' | 'sent';
  attempts: number;
  lastError: string | null;
  sentAt: number | null;
  messageId: string | null;
};

/** The index tables in memory, with the SQL's rules. */
export class FakeIndexDb {
  state: WavesChainIndexState = EMPTY_INDEX_STATE;
  readonly tables = new Map<IndexTableName, Map<string, IndexRow>>();

  private table(name: IndexTableName) {
    let table = this.tables.get(name);
    if (!table) {
      table = new Map();
      this.tables.set(name, table);
    }
    return table;
  }

  private key(name: IndexTableName, row: IndexRow) {
    return INDEX_TABLES[name].keys.map((k) => String(row[k])).join('|');
  }

  async loadState() {
    return this.state;
  }

  async saveState(state: WavesChainIndexState) {
    this.state = { ...state };
  }

  /** waves_chain_index_state.read_time, beside the state. */
  readTime: number | null = null;
  /** The read_height in the state when each read_time was saved. */
  readonly readTimeSavedAtHeight: (number | null)[] = [];
  /** No read_time column (a schema before the sync). */
  noReadTimeColumn = false;

  async saveReadTime(readTime: number) {
    if (this.noReadTimeColumn) return false;
    this.readTimeSavedAtHeight.push(this.state.readHeight);
    this.readTime = readTime;
    return true;
  }

  async upsert(
    name: IndexTableName,
    rows: readonly IndexRow[],
    stamp: RowStamp
  ) {
    const table = this.table(name);
    for (const row of rows) {
      if (!hasKeys(row, INDEX_TABLES[name].keys)) continue;
      const key = this.key(name, row);
      const stored = table.get(key);
      const generation = Math.max(
        Number(stored?.generation ?? 0),
        stamp.generation
      );
      if (stored && Number(stored.height) > stamp.height) {
        table.set(key, { ...stored, generation });
      } else {
        table.set(key, {
          ...JSON.parse(JSON.stringify(row)),
          height: stamp.height,
          generation
        });
      }
    }
  }

  async remove(name: IndexTableName, rows: readonly IndexRow[]) {
    for (const row of rows) this.table(name).delete(this.key(name, row));
  }

  async replaceChildren(
    name: IndexTableName,
    parentColumn: string,
    parentId: string,
    rows: readonly IndexRow[],
    stamp: RowStamp
  ) {
    const table = this.table(name);
    for (const [key, row] of Array.from(table.entries())) {
      if (row[parentColumn] === parentId) table.delete(key);
    }
    await this.upsert(name, rows, stamp);
  }

  /** Leaderboard rows written or deleted, in all. */
  leaderboardRowWrites = 0;

  /**
   * As the SQL: writes the rows that moved or are new, deletes the gone
   * ones; the others take only the generation.
   */
  async writeLeaderboardRows(
    decisionId: string,
    rows: readonly IndexRow[],
    stamp: RowStamp
  ) {
    const table = this.table('leaderboardRows');
    const what = (row: IndexRow) =>
      JSON.stringify([
        row.rank,
        row.legacy_id ?? null,
        row.author ?? null,
        String(row.score),
        String(row.total),
        row.data
      ]);
    const stored = Array.from(table.values()).filter(
      (row) => row.decision_id === decisionId
    );
    const byEntry = new Map(stored.map((row) => [String(row.entry_id), row]));
    const changed = rows.filter((row) => {
      const was = byEntry.get(String(row.entry_id));
      return !was || what(was) !== what(JSON.parse(JSON.stringify(row)));
    });
    const kept = new Set(rows.map((row) => String(row.entry_id)));
    const gone = stored.filter((row) => !kept.has(String(row.entry_id)));
    for (const row of gone) table.delete(this.key('leaderboardRows', row));
    await this.upsert('leaderboardRows', changed, stamp);
    for (const row of Array.from(table.values())) {
      if (
        row.decision_id === decisionId &&
        Number(row.generation) < stamp.generation
      ) {
        row.generation = stamp.generation;
      }
    }
    const written = changed.length + gone.length;
    this.leaderboardRowWrites += written;
    return written;
  }

  /** As the SQL: a stale vote keeps its value, its stamps still rise. */
  async applyVotes(changes: readonly VoteChange[], stamp: RowStamp) {
    const table = this.table('votes');
    for (const change of changes) {
      const row: IndexRow = {
        decision_id: change.decisionId,
        entry_id: change.entryId,
        voter: change.voter
      };
      const key = this.key('votes', row);
      const stored = table.get(key);
      if (change.value === null) {
        if (stored && Number(stored.updated_height) <= change.updatedHeight) {
          table.delete(key);
        }
        continue;
      }
      const newer =
        !stored || change.updatedHeight >= Number(stored.updated_height);
      table.set(key, {
        ...row,
        value: newer ? change.value : stored?.value,
        updated_height: Math.max(
          Number(stored?.updated_height ?? 0),
          change.updatedHeight
        ),
        height: Math.max(Number(stored?.height ?? 0), stamp.height),
        generation: Math.max(Number(stored?.generation ?? 0), stamp.generation)
      });
    }
  }

  async sweep(generation: number) {
    const removed: Record<string, number> = {};
    for (const name of Object.keys(INDEX_TABLES) as IndexTableName[]) {
      const table = this.table(name);
      removed[name] = 0;
      for (const [key, row] of Array.from(table.entries())) {
        if (Number(row.generation) < generation) {
          table.delete(key);
          removed[name]++;
        }
      }
    }
    return removed;
  }

  async clearAll() {
    this.tables.clear();
    this.events.length = 0;
  }

  // ------------------------------------------------------------ the log

  /** The log, in its order. */
  readonly events: ChainEvent[] = [];

  async eventObjects(ids: {
    entries?: readonly string[];
    decisions?: readonly string[];
    waves?: readonly string[];
    polls?: readonly string[];
    groups?: readonly string[];
  }) {
    const pick = (
      name: IndexTableName,
      wanted: readonly string[] | undefined,
      to: (row: IndexRow) => ObjectInfo
    ) => {
      const found = new Map<string, ObjectInfo>();
      for (const key of wanted ?? []) {
        const row = this.table(name).get(key);
        if (row) found.set(key, to(row));
      }
      return found;
    };
    const legacy = (row: IndexRow) => (row.legacy_id as string | null) ?? null;
    return {
      entries: pick('entries', ids.entries, (row) => ({
        legacyId: legacy(row),
        decisionId: row.decision_id as string,
        author: row.author as string,
        total: String(row.total),
        manifestHash:
          ((row.data as ChainObject)?.manifestHash as string | undefined) ??
          null
      })),
      decisions: pick('decisions', ids.decisions, (row) => {
        const config = ((row.data as ChainObject)?.config ?? {}) as ChainObject;
        return {
          legacyId: legacy(row),
          waveId: row.wave_id as string,
          creditScope: (config.creditScope as number | undefined) ?? null,
          creditSource: (config.creditSource as number | undefined) ?? null,
          status: row.status as string,
          statusHeight: Number(row.height)
        };
      }),
      waves: pick('waves', ids.waves, (row) => ({ legacyId: legacy(row) })),
      polls: pick('polls', ids.polls, (row) => ({
        legacyId: legacy(row),
        waveId: row.wave_id as string
      })),
      groups: pick('groups', ids.groups, (row) => ({ legacyId: legacy(row) }))
    };
  }

  async eventVotes(
    keys: readonly { decisionId: string; entryId: string; voter: string }[]
  ) {
    const found = new Map<string, StoredVote>();
    for (const key of keys) {
      const row = this.table('votes').get(
        this.key('votes', {
          decision_id: key.decisionId,
          entry_id: key.entryId,
          voter: key.voter
        })
      );
      if (row) {
        found.set(voteKey(key.decisionId, key.entryId, key.voter), {
          value: String(row.value),
          updatedHeight: Number(row.updated_height),
          generation: Number(row.generation)
        });
      }
    }
    return found;
  }

  async lastBallots(
    keys: readonly { pollId: string; cid: string }[],
    before: number
  ) {
    const found = new Map<string, StoredBallot>();
    for (const key of keys) {
      const last = this.events
        .filter(
          (e) =>
            e.kind === 'POLL_BALLOT' &&
            e.pollId === key.pollId &&
            e.actor === key.cid &&
            e.height < before
        )
        .at(-1);
      if (last) {
        found.set(ballotKey(key.pollId, key.cid), {
          selection: Number(last.data.newSelection),
          version: Number(last.data.version)
        });
      }
    }
    return found;
  }

  /**
   * Events derived again otherwise than the log holds them (a fault: the
   * SQL logs an error and keeps the stored row, as this does).
   */
  readonly derivedOtherwise: string[] = [];

  /** As the SQL: a place written again keeps its row. */
  async writeEvents(
    events: readonly ChainEvent[],
    eventsNext: number,
    scanState: ScanState,
    claimBuilds: readonly ClaimBuild[] = []
  ) {
    if (eventsNext < (this.state.eventsNext ?? 0)) {
      throw new Error(`events_next back from ${this.state.eventsNext}`);
    }
    const places = new Map(this.events.map((e) => [eventCursor(e), e]));
    const fresh: ChainEvent[] = [];
    for (const event of JSON.parse(JSON.stringify(events)) as ChainEvent[]) {
      const stored = places.get(eventCursor(event));
      if (!stored) fresh.push(event);
      else if (JSON.stringify(stored) !== JSON.stringify(event)) {
        this.derivedOtherwise.push(eventCursor(event));
      }
    }
    this.events.push(...fresh);
    this.events.sort((a, b) => a.height - b.height || a.seq - b.seq);
    for (const build of claimBuilds) {
      const key = `${build.network}|${build.decisionId}|${build.occurrence}`;
      if (this.claims.has(key)) continue;
      this.claims.set(key, {
        ...JSON.parse(JSON.stringify(build)),
        attempts: 0,
        lastError: null,
        sentAt: null,
        messageId: null
      });
    }
    this.state = { ...this.state, eventsNext, scanState };
    return this.derivedOtherwise.length;
  }

  /** chain_claim_builds, by `network|decision|occurrence`. */
  readonly claims = new Map<string, FakeClaimBuild>();

  /**
   * As the SQL: final, decided, native results of these (native in the
   * chain's answer too) with a rank-1 winner and no build.
   */
  async resultsWithoutClaimBuild(
    decisionIds: readonly string[],
    network: string,
    limit: number
  ) {
    return Array.from(this.table('results').values())
      .filter((row) => {
        const data = row.data as ChainObject;
        return (
          decisionIds.includes(row.decision_id as string) &&
          row.stage === 'final' &&
          row.status === 'decided' &&
          row.origin === 'native' &&
          data.origin === 'native' &&
          Array.isArray(data.winners) &&
          (data.winners as ChainObject[]).some((winner) => winner.rank === 1) &&
          !this.claims.has(`${network}|${row.decision_id}|${data.occurrence}`)
        );
      })
      .sort((a, b) => Number(a.result_time) - Number(b.result_time))
      .slice(0, limit)
      .map((row) => ({
        decisionId: row.decision_id as string,
        data: JSON.parse(JSON.stringify(row.data)) as ChainObject
      }));
  }

  /** As the SQL: a build already there is kept as it is. */
  async writeClaimBuilds(builds: readonly ClaimBuild[]) {
    for (const build of builds) {
      const key = `${build.network}|${build.decisionId}|${build.occurrence}`;
      if (this.claims.has(key)) continue;
      this.claims.set(key, {
        ...JSON.parse(JSON.stringify(build)),
        attempts: 0,
        lastError: null,
        sentAt: null,
        messageId: null
      });
    }
  }

  async pendingClaimBuilds(limit: number) {
    return Array.from(this.claims.values())
      .filter((c) => c.status === 'pending')
      .sort(
        (a, b) =>
          a.height - b.height ||
          a.decisionId.localeCompare(b.decisionId) ||
          a.occurrence - b.occurrence
      )
      .slice(0, limit)
      .map((c) => ({
        network: c.network,
        decisionId: c.decisionId,
        occurrence: c.occurrence,
        message: c.message as ClaimBuildMessage,
        attempts: c.attempts
      }));
  }

  private claim(key: {
    network: string;
    decisionId: string;
    occurrence: number;
  }) {
    return this.claims.get(
      `${key.network}|${key.decisionId}|${key.occurrence}`
    );
  }

  async claimBuildSent(
    key: { network: string; decisionId: string; occurrence: number },
    messageId: string | null,
    now: number
  ) {
    const claim = this.claim(key);
    if (claim?.status !== 'pending') return;
    claim.status = 'sent';
    claim.attempts++;
    claim.sentAt = now;
    claim.messageId = messageId;
    claim.lastError = null;
  }

  async claimBuildFailed(
    key: { network: string; decisionId: string; occurrence: number },
    error: string
  ) {
    const claim = this.claim(key);
    if (claim?.status !== 'pending') return;
    claim.attempts++;
    claim.lastError = error;
  }

  async readEvents(
    after: string | null,
    limit: number,
    kinds?: readonly string[]
  ) {
    const place = parseEventCursor(after);
    const network = this.state.network;
    if (place?.network && network && place.network !== network) {
      throw new EventCursorError(`${after}: another network's cursor`);
    }
    const appliedHeight =
      this.state.feedNext === null ? null : this.state.feedNext - 1;
    const events = this.events
      .filter((e) => appliedHeight !== null && e.height <= appliedHeight)
      .filter(
        (e) =>
          !place ||
          e.height > place.height ||
          (e.height === place.height && e.seq > place.seq)
      )
      .filter((e) => !kinds?.length || kinds.includes(e.kind))
      .slice(0, Math.max(1, Math.min(limit, MAX_READ_EVENTS)));
    return {
      events,
      next: events.length
        ? eventCursor(events[events.length - 1], network)
        : after,
      appliedHeight,
      network
    };
  }

  async decisionStatuses(ids: readonly string[]) {
    const found = new Map<string, { status: string; counted: boolean }>();
    for (const decisionId of ids) {
      const row = this.table('decisions').get(decisionId);
      if (row) {
        found.set(decisionId, {
          status: String(row.status),
          counted: (row.data as ChainObject)?.counted === true
        });
      }
    }
    return found;
  }

  async timeDependent(now: number) {
    const decisionIds = Array.from(this.table('decisions').values())
      .filter((d) => {
        const data = d.data as ChainObject;
        return (
          data?.counted === true &&
          (d.status === 'published' ||
            d.due === true ||
            data?.phase === 'settling')
        );
      })
      .sort(
        (a, b) =>
          Number(a.height) - Number(b.height) ||
          String(a.decision_id).localeCompare(String(b.decision_id))
      )
      .map((d) => String(d.decision_id));
    const roleWaves = new Map<string, number>();
    for (const r of Array.from(this.table('roles').values())) {
      const expiresAt = Number((r.data as ChainObject)?.expiresAt ?? 0);
      if (r.live === true && expiresAt >= 1 && expiresAt <= now) {
        const wave = String(r.wave_id);
        roleWaves.set(
          wave,
          Math.min(roleWaves.get(wave) ?? Infinity, Number(r.height))
        );
      }
    }
    const roleWaveIds = Array.from(roleWaves.entries())
      .sort(([a, ha], [b, hb]) => ha - hb || a.localeCompare(b))
      .map(([wave]) => wave);
    return { decisionIds, roleWaveIds };
  }

  /** A table's rows, without the read stamp unless asked, in key order. */
  rows(name: IndexTableName, withStamp = false): IndexRow[] {
    return Array.from(this.table(name).entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, row]) => {
        if (withStamp) return row;
        const { height: _h, generation: _g, ...rest } = row;
        return rest;
      });
  }

  asDb(): WavesChainIndexDb {
    return this as unknown as WavesChainIndexDb;
  }
}
