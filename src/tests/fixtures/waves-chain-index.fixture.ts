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
  RowStamp,
  WavesChainIndexDb,
  WavesChainIndexState
} from '@/waves-chain-index/waves-chain-index.db';
import { VoteChange } from '@/waves-chain-index/waves-chain-index.feed';
import { hasKeys, IndexRow } from '@/waves-chain-index/waves-chain-index.rows';

/**
 * An in-memory chain and index for the index's tests. The chain keeps its
 * state at every height and answers a read at the height it is pinned to,
 * with the time of that height's block; every change is a new block with
 * the feed records the chain would write.
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
    votes: new Map()
  };
}

function byId(field: string) {
  return (a: ChainObject, b: ChainObject) =>
    String(a[field]).localeCompare(String(b[field]));
}

export class FakeChain implements WavesChainApi {
  height = 100;
  completed = true;
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

  /** A new block, a second later than the last, holding these records. */
  commit(records: FeedRecord[]) {
    this.clock.t += 1000;
    this.height++;
    this.snapshots.set(this.height, structuredClone(this.live));
    this.times.set(this.height, this.clock.t);
    this.blocks.push({
      height: this.height,
      slot: this.height,
      root: id(0),
      time: this.clock.t,
      records: records.map((r) => ({
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

  /** Time passes: empty blocks up to `ms` later. */
  tick(ms: number) {
    this.clock.t += ms - 1000;
    this.commit([]);
  }

  putGroup(groupId: string, fields: ChainObject = {}) {
    this.live.groups.set(groupId, {
      groupId,
      version: 1,
      origin: 'legacy',
      ...fields
    });
    this.commit([{ family: '0x0401', keyFields: { groupId } }]);
  }

  putWave(waveId: string, fields: ChainObject = {}) {
    this.live.waves.set(waveId, {
      waveId,
      legacyId: null,
      status: 'open',
      membersOnly: false,
      readGroup: { groupId: id(0), version: 0 },
      postGroup: { groupId: id(0), version: 0 },
      adminGroup: { groupId: id(0), version: 0 },
      decisions: 0,
      origin: 'native',
      ...fields
    });
    this.commit([{ family: '0x0501', keyFields: { waveId } }]);
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
      ...fields
    });
    this.commit([
      { family: '0x060b', keyFields: { pollId } },
      { family: '0x0613', keyFields: { waveId } }
    ]);
  }

  /** A poll closes: Poll, PollCount and its Result (under the poll id). */
  closePoll(pollId: string) {
    const poll = this.live.polls.get(pollId) as ChainObject;
    this.live.polls.set(pollId, { ...poll, status: 'closed' });
    this.live.results.set(pollId, [
      { id: pollId, resultTime: poll.closeTime, status: 'decided' }
    ]);
    this.commit([
      { family: '0x060b', keyFields: { pollId } },
      { family: '0x0613', keyFields: { waveId: poll.waveId } },
      { family: '0x060a', keyFields: { id: pollId, D: poll.closeTime } }
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
      ...fields
    });
    this.commit([{ family: '0x0601', keyFields: { decisionId } }]);
  }

  putEntry(entryId: string, decisionId: string, fields: ChainObject = {}) {
    this.live.entries.set(entryId, {
      entryId,
      decisionId,
      author: id('a1'),
      status: 'active',
      total: '0',
      tLast: 0,
      origin: 'native',
      ...(this.live.entries.get(entryId) ?? {}),
      ...fields
    });
    this.commit([{ family: '0x0603', keyFields: { entryId } }]);
  }

  vote(entryId: string, voter: string, value: number, undecodable = false) {
    const entry = this.live.entries.get(entryId) as ChainObject;
    const decisionId = entry.decisionId as string;
    const votes =
      this.live.votes.get(entryId) ?? new Map<string, ChainObject>();
    const updatedHeight = this.height + 1;
    if (value === 0) votes.delete(voter);
    else {
      votes.set(voter, {
        voter,
        decisionId,
        entryId,
        value: String(value),
        updatedHeight,
        index: 0
      });
    }
    this.live.votes.set(entryId, votes);
    const total = Array.from(votes.values()).reduce(
      (sum, v) => sum + Number(v.value),
      0
    );
    this.live.entries.set(entryId, {
      ...entry,
      total: String(total),
      tLast: this.clock.t + 1000
    });
    this.commit([
      {
        family: '0x0607',
        keyFields: { voter, decisionId, entryId },
        valueFields:
          value === 0
            ? null
            : { value: String(value), updatedHeight, index: 0 },
        undecodable
      },
      { family: '0x0603', keyFields: { entryId } }
    ]);
  }

  putResult(decisionId: string, resultTime: number, fields: ChainObject = {}) {
    const list = (this.live.results.get(decisionId) ?? []).filter(
      (r) => r.resultTime !== resultTime
    );
    list.push({
      id: decisionId,
      resultTime,
      status: 'decided',
      stage: 'final',
      origin: 'native',
      ...fields
    });
    list.sort((a, b) => Number(a.resultTime) - Number(b.resultTime));
    this.live.results.set(decisionId, list);
    this.commit([
      { family: '0x060a', keyFields: { id: decisionId, D: resultTime } }
    ]);
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
    return { completed: this.completed };
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

  async saveReadTime(readTime: number) {
    this.readTime = readTime;
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
