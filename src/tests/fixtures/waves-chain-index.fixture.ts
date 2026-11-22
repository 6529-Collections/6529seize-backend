import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import {
  ChainFeedBlock,
  ChainFeedPage
} from '@/chain-gateway/chain-gateway.types';
import {
  ChainObject,
  ChainPage,
  WavesChainApi,
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
 * An in-memory chain and index for the index's tests. The chain answers
 * from its current state (tests move the height with each change), and
 * writes a feed record for every change.
 */

export const id = (n: number | string) =>
  `0x${String(n).padStart(64, '0')}`.toLowerCase();

export class FakeClock {
  t = 1_764_000_000_000;
  now = () => this.t;
}

type Record_ = {
  family: string;
  keyFields: Record<string, unknown>;
  valueFields?: Record<string, unknown> | null;
};

export class FakeChain implements WavesChainApi {
  height = 100;
  completed = true;
  /** Feed heights below this answer `gone`. */
  goneBelow = 0;
  /** The finalized height trails the feed's by this much (a newer node). */
  lag = 0;
  /** Each call moves the clock by this much. */
  callMs = 0;
  calls = 0;
  failOn: string | null = null;
  readonly blocks: ChainFeedBlock[] = [];
  readonly groups = new Map<string, ChainObject>();
  readonly waves = new Map<string, ChainObject>();
  readonly roles = new Map<string, ChainObject[]>();
  readonly rep = new Map<string, ChainObject[]>();
  readonly polls = new Map<string, ChainObject>();
  readonly decisions = new Map<string, ChainObject>();
  readonly entries = new Map<string, ChainObject>();
  readonly results = new Map<string, ChainObject[]>();
  /** entryId -> voter -> vote */
  readonly votes = new Map<string, Map<string, ChainObject>>();

  constructor(private readonly clock: FakeClock) {}

  private call(name: string) {
    this.calls++;
    this.clock.t += this.callMs;
    if (this.failOn === name) throw new Error(`${name} failed`);
  }

  // ------------------------------------------------------------ changes

  /** A new block holding these records. */
  commit(records: Record_[]) {
    this.height++;
    this.blocks.push({
      height: this.height,
      slot: this.height,
      root: id(0),
      time: this.clock.t,
      records: records.map((r) => ({
        family: r.family,
        name: 'r',
        key: '0x',
        value: r.valueFields === null ? null : '0x',
        keyFields: r.keyFields,
        valueFields: r.valueFields === undefined ? {} : r.valueFields
      }))
    });
  }

  putGroup(groupId: string, fields: ChainObject = {}, record = true) {
    this.groups.set(groupId, {
      groupId,
      version: 1,
      origin: 'legacy',
      ...fields
    });
    if (record) this.commit([{ family: '0x0401', keyFields: { groupId } }]);
  }

  putWave(waveId: string, fields: ChainObject = {}, record = true) {
    this.waves.set(waveId, {
      waveId,
      legacyId: null,
      status: 'open',
      membersOnly: false,
      readGroup: { groupId: id(0), version: 0 },
      postGroup: { groupId: id(0), version: 0 },
      adminGroup: { groupId: id(0), version: 0 },
      origin: 'native',
      ...fields
    });
    if (record) this.commit([{ family: '0x0501', keyFields: { waveId } }]);
  }

  putRole(waveId: string, principalId: string, fields: ChainObject = {}) {
    const list = (this.roles.get(waveId) ?? []).filter(
      (r) => r.principalId !== principalId
    );
    list.push({
      role: 'admin',
      principalId,
      version: 1,
      live: true,
      ...fields
    });
    this.roles.set(waveId, list);
    this.commit([
      {
        family: '0x0403',
        keyFields: { scopeId: waveId, role: 'admin', principalId }
      }
    ]);
  }

  rate(waveId: string, rater: string, value: number) {
    const list = (this.rep.get(waveId) ?? []).filter((r) => r.rater !== rater);
    if (value !== 0) {
      list.push({
        rater,
        waveId,
        category: { id: id('c'), name: 'Cat' },
        value,
        updatedHeight: this.height + 1
      });
    }
    this.rep.set(waveId, list);
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
    this.polls.set(pollId, {
      pollId,
      waveId,
      status: 'open',
      origin: 'native',
      ...fields
    });
    this.commit([{ family: '0x060b', keyFields: { pollId } }]);
  }

  putDecision(decisionId: string, waveId: string, fields: ChainObject = {}) {
    this.decisions.set(decisionId, {
      decisionId,
      waveId,
      status: 'published',
      kind: 'rank',
      counted: false,
      due: false,
      phase: 'open',
      nextResultTime: 0,
      origin: 'native',
      ...fields
    });
    this.commit([{ family: '0x0601', keyFields: { decisionId } }]);
  }

  putEntry(entryId: string, decisionId: string, fields: ChainObject = {}) {
    this.entries.set(entryId, {
      entryId,
      decisionId,
      author: id('a1'),
      status: 'active',
      total: '0',
      origin: 'native',
      ...(this.entries.get(entryId) ?? {}),
      ...fields
    });
    this.commit([{ family: '0x0603', keyFields: { entryId } }]);
  }

  vote(entryId: string, voter: string, value: number) {
    const entry = this.entries.get(entryId) as ChainObject;
    const decisionId = entry.decisionId as string;
    const votes = this.votes.get(entryId) ?? new Map<string, ChainObject>();
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
    this.votes.set(entryId, votes);
    const total = Array.from(votes.values()).reduce(
      (sum, v) => sum + Number(v.value),
      0
    );
    this.entries.set(entryId, { ...entry, total: String(total) });
    this.commit([
      {
        family: '0x0607',
        keyFields: { voter, decisionId, entryId },
        valueFields:
          value === 0 ? null : { value: String(value), updatedHeight, index: 0 }
      },
      { family: '0x0603', keyFields: { entryId } }
    ]);
  }

  putResult(decisionId: string, resultTime: number, fields: ChainObject = {}) {
    const list = (this.results.get(decisionId) ?? []).filter(
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
    this.results.set(decisionId, list);
    this.commit([
      { family: '0x060a', keyFields: { id: decisionId, D: resultTime } }
    ]);
  }

  // ------------------------------------------------------------ reads

  async finalizedHeight() {
    this.call('finalizedHeight');
    return this.height - this.lag;
  }

  async importState(): Promise<WavesImportState | null> {
    this.call('importState');
    return { completed: this.completed };
  }

  private list(
    map: Map<string, ChainObject>,
    after: string | null,
    size = 2
  ): ChainPage<ChainObject> {
    const ids = Array.from(map.keys())
      .sort()
      .filter((key) => after === null || key > after);
    const items = ids.slice(0, size).map((key) => map.get(key)!);
    return {
      items,
      next: ids.length > size ? ids[size - 1] : null
    };
  }

  async listGroups(after: string | null) {
    this.call('listGroups');
    return this.list(this.groups, after);
  }

  async listWaves(after: string | null) {
    this.call('listWaves');
    return this.list(this.waves, after);
  }

  async listDecisions(after: string | null) {
    this.call('listDecisions');
    const page = this.list(this.decisions, after);
    return { ...page, items: page.items.map((d) => this.decisionAnswer(d)) };
  }

  /** A live counted decision's answer moves with its block time. */
  private decisionAnswer(decision: ChainObject): ChainObject {
    return decision.counted && decision.status === 'published'
      ? { ...decision, readAt: this.clock.t }
      : decision;
  }

  async group(groupId: string) {
    this.call('group');
    return this.groups.get(groupId) ?? null;
  }

  async wave(waveId: string) {
    this.call('wave');
    return this.waves.get(waveId) ?? null;
  }

  async decision(decisionId: string) {
    this.call('decision');
    const decision = this.decisions.get(decisionId);
    return decision ? this.decisionAnswer(decision) : null;
  }

  async entry(entryId: string) {
    this.call('entry');
    return this.entries.get(entryId) ?? null;
  }

  async poll(pollId: string) {
    this.call('poll');
    return this.polls.get(pollId) ?? null;
  }

  async result(decisionId: string, resultTime: number) {
    this.call('result');
    return (
      (this.results.get(decisionId) ?? []).find(
        (r) => r.resultTime === resultTime
      ) ?? null
    );
  }

  async decisionLeaderboard(decisionId: string) {
    this.call('decisionLeaderboard');
    const decision = this.decisions.get(decisionId);
    if (!decision) return null;
    const rows = Array.from(this.entries.values())
      .filter((e) => e.decisionId === decisionId && e.status === 'active')
      .sort(
        (a, b) =>
          Number(b.total) - Number(a.total) ||
          String(a.entryId).localeCompare(String(b.entryId))
      )
      .map((e, i) => ({ rank: i + 1, entryId: e.entryId, total: e.total }));
    return {
      decisionId,
      scoredAt: decision.counted ? this.clock.t : 0,
      count: rows.length,
      rows
    };
  }

  async waveRoles(waveId: string) {
    this.call('waveRoles');
    return this.waves.has(waveId) ? [...(this.roles.get(waveId) ?? [])] : null;
  }

  async wavePolls(waveId: string) {
    this.call('wavePolls');
    if (!this.waves.has(waveId)) return null;
    return Array.from(this.polls.values()).filter((p) => p.waveId === waveId);
  }

  async waveRep(waveId: string) {
    this.call('waveRep');
    return this.waves.has(waveId) ? [...(this.rep.get(waveId) ?? [])] : null;
  }

  async decisionEntries(decisionId: string) {
    this.call('decisionEntries');
    if (!this.decisions.has(decisionId)) return null;
    return Array.from(this.entries.values())
      .filter((e) => e.decisionId === decisionId)
      .sort((a, b) => String(a.entryId).localeCompare(String(b.entryId)));
  }

  async decisionResults(decisionId: string) {
    this.call('decisionResults');
    if (!this.decisions.has(decisionId)) return null;
    return [...(this.results.get(decisionId) ?? [])];
  }

  async entryVotes(entryId: string) {
    this.call('entryVotes');
    if (!this.entries.has(entryId)) return null;
    return Array.from(this.votes.get(entryId)?.values() ?? []).sort((a, b) =>
      String(a.voter).localeCompare(String(b.voter))
    );
  }

  async feed(from: number): Promise<ChainFeedPage> {
    this.call('feed');
    if (from < this.goneBelow) {
      throw new ChainGatewayError('/v1/feed: gone', 410, 'gone', '/v1/feed');
    }
    const through = this.height;
    const blocks = this.blocks
      .filter((b) => b.height >= from && b.height <= through)
      .slice(0, 3);
    const last = blocks.length === 3 ? blocks[2].height : through;
    return { from, through: last, blocks, next: last + 1 };
  }
}

/** The index tables in memory, with the database's rules. */
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
      const fresh = {
        ...JSON.parse(JSON.stringify(row)),
        height: stamp.height,
        generation: stamp.generation
      };
      if (stored && Number(stored.height) > stamp.height) {
        table.set(key, {
          ...stored,
          generation: Math.max(Number(stored.generation), stamp.generation)
        });
      } else {
        table.set(key, {
          ...fresh,
          generation: Math.max(
            Number(stored?.generation ?? 0),
            stamp.generation
          )
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
      if (stored && Number(stored.updated_height) > change.updatedHeight) {
        continue;
      }
      table.set(key, {
        ...row,
        value: change.value,
        updated_height: change.updatedHeight,
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

  async timeDependent(now: number) {
    const decisionIds = Array.from(this.table('decisions').values())
      .filter(
        (d) =>
          d.status === 'published' ||
          d.due === true ||
          (d.data as ChainObject)?.phase === 'settling'
      )
      .map((d) => String(d.decision_id))
      .sort();
    const pollIds = Array.from(this.table('polls').values())
      .filter((p) => p.status === 'open')
      .map((p) => String(p.poll_id))
      .sort();
    const roleWaveIds = Array.from(
      new Set(
        Array.from(this.table('roles').values())
          .filter((r) => {
            const expiresAt = Number((r.data as ChainObject)?.expiresAt ?? 0);
            return r.live === true && expiresAt >= 1 && expiresAt <= now;
          })
          .map((r) => String(r.wave_id))
      )
    ).sort();
    return { decisionIds, pollIds, roleWaveIds };
  }

  /** A table's rows without the read stamp, in key order. */
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
