import {
  DOC_CLASS,
  docCid,
  docCommitment,
  nonceWordOf
} from '@/waves-chain-mirror/waves-chain-mirror.docs';
import {
  EMPTY_MIRROR_STATE,
  EntryHold,
  WavesChainMirrorState
} from '@/waves-chain-mirror/waves-chain-mirror.db';
import { DecisionPlan } from '@/waves-chain-mirror/waves-chain-mirror.plan';
import { NativeEntryLookup } from '@/waves-chain-mirror/waves-chain-mirror.native-entries';
import { VoteEvent } from '@/waves-chain-mirror/waves-chain-mirror.history';
import {
  MirrorIndex,
  MirrorStore
} from '@/waves-chain-mirror/waves-chain-mirror.service';
import {
  ChainBoardRow,
  ChainDecisionRow,
  ChainDecisionState,
  ChainEntryRow,
  ChainResultRow,
  ChainVoteRow,
  MirrorLookups,
  SkippedClaimBuild,
  TargetCompetition,
  TargetCompetitionState,
  TargetEntry
} from '@/waves-chain-mirror/waves-chain-mirror.types';
import {
  EMPTY_INDEX_STATE,
  WavesChainIndexState
} from '@/waves-chain-index/waves-chain-index.db';
import {
  ChainEvent,
  eventCursor,
  parseEventCursor
} from '@/waves-chain-index/waves-chain-index.events';

/**
 * Made-up chain and 6529.io rows for the waves chain mirror's tests, and an
 * in-memory store and index for its service.
 */

export const chainId = (n: number | string) =>
  `0x${String(n).padStart(64, '0')}`.toLowerCase();

export const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ------------------------------------------------------------ documents

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort((a, b) => (a < b ? -1 : Number(a > b)))
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

/** A waves document's bytes: canonical JSON and a newline. */
export function canonicalDocBytes(doc: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(canonical(doc))}\n`);
}

/** A version 1 entry manifest, as the frontend's entryManifest.ts makes it. */
export function entryManifestDoc(input: {
  nonce: string;
  decision: string;
  wave: string;
  author: string;
  createdAt: number;
  fields: Record<string, unknown>;
  consent?: Record<string, unknown> | null;
  kind?: string;
}) {
  const doc = {
    ...input.fields,
    v: 1,
    kind: input.kind ?? 'entry',
    nonce: input.nonce,
    decision: input.decision,
    wave: input.wave,
    author: input.author,
    created_at: input.createdAt,
    consent: input.consent ?? null
  };
  const bytes = canonicalDocBytes(doc);
  const nonceWord = nonceWordOf(input.nonce) ?? `0x${'00'.repeat(32)}`;
  return {
    doc,
    bytes,
    manifestHash: docCommitment(DOC_CLASS.ENTRY_MANIFEST, nonceWord, bytes),
    contentCid: docCid(bytes)
  };
}

// ------------------------------------------------------------ chain rows

export function aChainDecision(
  fields: Partial<ChainDecisionRow> & { decisionId: string }
): ChainDecisionRow {
  return {
    legacyId: null,
    waveId: chainId('a0'),
    status: 'published',
    kind: 'rank',
    nextResultTime: 0,
    origin: 'legacy',
    height: 10,
    data: { counted: true, config: { timeLock: '0' } },
    ...fields
  };
}

export function aChainEntry(
  fields: Partial<ChainEntryRow> & { entryId: string; decisionId: string }
): ChainEntryRow {
  return {
    legacyId: null,
    author: chainId('a1'),
    status: 'active',
    total: '0',
    origin: 'legacy',
    height: 10,
    data: {
      lastIncrease: { time: 0, height: 0, index: 0 },
      createdMs: 1_763_000_000_000
    },
    ...fields
  };
}

export function aChainVote(
  entryId: string,
  voter: string,
  value: string | number,
  updatedHeight = 10
): ChainVoteRow {
  return { entryId, voter, value: String(value), updatedHeight };
}

export function aBoardRow(
  entryId: string,
  rank: number,
  score: string | number,
  total: string | number,
  data: Record<string, unknown> = {}
): ChainBoardRow {
  return {
    entryId,
    rank,
    score: String(score),
    total: String(total),
    data: { lastIncrease: { time: 0, height: 0, index: 0 }, ...data }
  };
}

export function aChainResult(
  fields: Partial<ChainResultRow> & { resultTime: number }
): ChainResultRow {
  return {
    status: 'decided',
    stage: 'final',
    origin: 'native',
    height: 20,
    data: {},
    ...fields
  };
}

export function aChainDecisionState(
  decision: ChainDecisionRow,
  parts: Partial<Omit<ChainDecisionState, 'decision'>> = {}
): ChainDecisionState {
  return {
    decision,
    entries: [],
    votes: [],
    board: decision.status === 'published' ? [] : null,
    results: [],
    ...parts
  };
}

// ------------------------------------------------------------ 6529.io rows

export function aCompetition(
  fields: Partial<TargetCompetition> & { id: string }
): TargetCompetition {
  return {
    waveId: uuid(900),
    legacyWaveId: uuid(900),
    type: 'RANK',
    lifecycle: 'PUBLISHED',
    decisionConfig: { time_lock_ms: null, next_decision_time: null },
    outcomeConfig: [],
    capabilities: [],
    publishedAt: 1_700_000_000_000,
    endedAt: null,
    archivedAt: null,
    ...fields
  };
}

export function aTargetEntry(
  fields: Partial<TargetEntry> & { id: string; dropId: string }
): TargetEntry {
  return {
    submitterId: 'profile-author',
    status: 'ACTIVE',
    configVersion: 1,
    submittedAt: 1_763_000_000_000,
    withdrawnAt: null,
    disqualifiedAt: null,
    wonAt: null,
    rank: null,
    decisionId: null,
    ...fields
  };
}

export function aTargetState(
  competition: TargetCompetition,
  parts: Partial<Omit<TargetCompetitionState, 'competition'>> = {}
): TargetCompetitionState {
  return {
    competition,
    entries: [],
    votes: [],
    runtime: [],
    board: [],
    decisions: [],
    winners: [],
    winnerVotes: [],
    awards: [],
    scoreHistory: [],
    ...parts
  };
}

/** Lookups over plain maps; anything not given is unknown. */
export function someLookups(
  fields: {
    network?: string | null;
    now?: number;
    profiles?: Record<string, string>;
    blockTimes?: Record<number, number>;
    resultFinalTimes?: Record<number, number>;
    releasedVotes?: Record<string, Record<string, string>>;
    nativeEntries?: Record<string, NativeEntryLookup>;
    skippedClaimBuilds?: SkippedClaimBuild[];
    voteEvents?: VoteEvent[];
  } = {}
): MirrorLookups {
  const profiles = fields.profiles ?? {};
  const mapped = new Set(Object.values(profiles));
  return {
    network: fields.network ?? 'net-1',
    now: fields.now ?? 1_765_000_000_000,
    profileOf: (p) => profiles[p] ?? null,
    hasPrincipal: (profile) => mapped.has(profile),
    blockTime: (h) => fields.blockTimes?.[h] ?? null,
    resultFinalTime: (t) => fields.resultFinalTimes?.[t] ?? null,
    skippedClaimBuilds: () => fields.skippedClaimBuilds ?? [],
    voteEvents: () => fields.voteEvents ?? [],
    releasedVotes: (e) =>
      new Map(Object.entries(fields.releasedVotes?.[e] ?? {})),
    nativeEntry: (e) => fields.nativeEntries?.[e] ?? null
  };
}

// ------------------------------------------------------------ fakes

/** An in-memory event log with the index's readEvents rules. */
export class FakeMirrorIndex implements MirrorIndex {
  state: WavesChainIndexState = {
    ...EMPTY_INDEX_STATE,
    generation: 1,
    lastFullAt: 1,
    feedNext: 101,
    network: 'net-1'
  };
  events: ChainEvent[] = [];
  reads: (string | null)[] = [];

  async loadState() {
    return this.state;
  }

  async readEvents(after: string | null, limit: number) {
    this.reads.push(after);
    const place = parseEventCursor(after);
    const applied = (this.state.feedNext ?? 1) - 1;
    const events = this.events
      .filter(
        (e) =>
          e.height <= applied &&
          (!place ||
            e.height > place.height ||
            (e.height === place.height && e.seq > place.seq))
      )
      .sort((a, b) => a.height - b.height || a.seq - b.seq)
      .slice(0, limit);
    return {
      events,
      next: events.length
        ? eventCursor(events[events.length - 1], this.state.network)
        : after,
      appliedHeight: applied,
      network: this.state.network
    };
  }
}

export function anEvent(
  height: number,
  seq: number,
  fields: Partial<ChainEvent> = {}
): ChainEvent {
  return {
    height,
    seq,
    blockTime: 1_764_000_000_000 + height * 1000,
    kind: 'VOTE',
    origin: 'OPERATION',
    waveId: null,
    waveLegacyId: null,
    decisionId: null,
    decisionLegacyId: null,
    entryId: null,
    entryLegacyId: null,
    pollId: null,
    pollLegacyId: null,
    groupId: null,
    groupLegacyId: null,
    actor: null,
    data: {},
    ...fields
  };
}

/** The mirror's store over in-memory chain and 6529.io rows. */
export class FakeMirrorStore implements MirrorStore {
  state: WavesChainMirrorState = EMPTY_MIRROR_STATE;
  savedStates: WavesChainMirrorState[] = [];
  principalMap = true;
  chain = new Map<string, ChainDecisionState>();
  target = new Map<string, TargetCompetitionState>();
  profiles = new Map<string, string>();
  live: string[] = [];
  changedAbove: (height: number) => string[] = () => [];
  applied: { competitionId: string; writes: DecisionPlan['writes'] }[] = [];
  transactions = 0;
  /** Thrown by the next transactions, in order (a deadlock, say). */
  failures: unknown[] = [];
  /** Decisions whose reads throw. */
  broken = new Set<string>();
  /** Applies writes to `target`, as the SQL would. */
  applyToTarget: (
    target: TargetCompetitionState,
    writes: DecisionPlan['writes']
  ) => TargetCompetitionState = applyWritesInMemory;

  async loadState() {
    return this.state;
  }
  async saveState(state: WavesChainMirrorState) {
    this.state = state;
    this.savedStates.push(state);
  }
  async hasPrincipalMap() {
    return this.principalMap;
  }
  async decisionIdsAfter(after: string | null, limit: number) {
    return Array.from(this.chain.keys())
      .sort((a, b) => (a < b ? -1 : Number(a > b)))
      .filter((id) => after === null || id > after)
      .slice(0, limit);
  }
  async liveDecisionIds() {
    return this.live;
  }
  async decisionIdsChangedAbove(height: number) {
    return this.changedAbove(height);
  }
  async chainDecision(id: string) {
    if (this.broken.has(id)) throw new Error(`broken ${id}`);
    return this.chain.get(id) ?? null;
  }
  async blockTimes() {
    return new Map<number, number>();
  }
  reportPlace: string | null = null;
  async loadReportPlace() {
    return this.reportPlace;
  }
  async saveReportPlace(after: string | null) {
    this.reportPlace = after;
  }
  removedNetworks: string[] = [];
  async removeOtherNetworksResults(keepPrefix: string) {
    this.removedNetworks.push(keepPrefix);
    return 0;
  }
  releasedChainMade = 0;
  async releaseChainMadeEntries() {
    this.releasedChainMade++;
    return 0;
  }
  async resultFinalTimes() {
    return new Map<number, number>();
  }
  async nativeEntryContext(competitionId: string, dropIds: readonly string[]) {
    const target = this.target.get(competitionId);
    if (!target) return null;
    const drops = new Set(target.entries.map((e) => e.dropId));
    return {
      waveId: target.competition.waveId,
      waveName: 'A wave',
      participation: {},
      terms: null,
      signatureRequired: false,
      mainStage: target.competition.capabilities.includes('MAIN_STAGE'),
      existing: new Set(dropIds.filter((id) => drops.has(id)))
    };
  }
  held = new Map<string, EntryHold>();
  async heldEntries(entryIds: readonly string[]) {
    return new Map(
      entryIds.flatMap((id) =>
        this.held.has(id)
          ? [[id, this.held.get(id)!] as [string, EntryHold]]
          : []
      )
    );
  }
  async holdEntry(entryId: string, _competitionId: string, hold: EntryHold) {
    // A refusal stays as it is.
    if (this.held.get(entryId)?.retryAt === null) return;
    this.held.set(entryId, hold);
  }
  async releaseHold(entryId: string) {
    if (this.held.get(entryId)?.retryAt !== null) this.held.delete(entryId);
  }
  docs = new Map<string, Uint8Array>();
  async findDocument(cid: string) {
    return this.docs.get(cid) ?? null;
  }
  async saveDocument(cid: string, _docClass: number, bytes: Uint8Array) {
    this.docs.set(cid, bytes);
  }
  skipped: SkippedClaimBuild[] = [];
  async skippedClaimBuilds() {
    return this.skipped;
  }
  async releasedVotes() {
    return new Map<string, Map<string, string>>();
  }
  /** A live store: no rebuild's imported rows. */
  async writeImportedDecisionRows() {
    return {};
  }
  /** The event log a decision's VOTE events are read again from. */
  logged: () => readonly ChainEvent[] = () => [];
  replayReads: { decisionId: string; after: string | null }[] = [];
  async decisionVoteEvents(
    decisionId: string,
    entryIds: readonly string[],
    after: { readonly height: number; readonly seq: number } | null,
    upTo: { readonly height: number; readonly seq: number },
    limit: number
  ) {
    this.replayReads.push({
      decisionId,
      after: after ? `${after.height}:${after.seq}` : null
    });
    const entries = new Set(entryIds);
    const at = (e: ChainEvent) => e.height * 2 ** 20 + e.seq;
    return this.logged()
      .filter(
        (e) =>
          e.kind === 'VOTE' &&
          e.decisionId === decisionId &&
          e.entryId !== null &&
          entries.has(e.entryId) &&
          (!after || at(e) > at(after as ChainEvent)) &&
          at(e) <= at(upTo as ChainEvent)
      )
      .sort((a, b) => at(a) - at(b))
      .slice(0, limit);
  }
  async profilesOfPrincipals(principals: readonly string[]) {
    const out = new Map<string, string>();
    for (const p of principals) {
      const profile = this.profiles.get(p);
      if (profile) out.set(p, profile);
    }
    return out;
  }
  async profilesWithPrincipal(profileIds: readonly string[]) {
    const mapped = new Set(this.profiles.values());
    return new Set(profileIds.filter((id) => mapped.has(id)));
  }
  async targetCompetition(competitionId: string) {
    return this.target.get(competitionId) ?? null;
  }
  async applyWrites(
    plan: Pick<DecisionPlan, 'competitionId' | 'waveId' | 'writes'>
  ) {
    const competitionId = plan.competitionId;
    this.applied.push({ competitionId, writes: plan.writes });
    const target = this.target.get(competitionId);
    if (target) {
      this.target.set(competitionId, this.applyToTarget(target, plan.writes));
    }
  }
  async inTransaction<T>(fn: (connection: any) => Promise<T>): Promise<T> {
    this.transactions++;
    if (this.failures.length) throw this.failures.shift();
    return fn({ connection: {} });
  }
}

/** What the SQL of a plan's writes leaves, on in-memory rows. */
export function applyWritesInMemory(
  target: TargetCompetitionState,
  writes: DecisionPlan['writes']
): TargetCompetitionState {
  const upsert = <T>(
    rows: readonly T[],
    added: readonly T[],
    key: (row: T) => string
  ): T[] => {
    const out = new Map(rows.map((row) => [key(row), row]));
    for (const row of added)
      out.set(key(row), { ...out.get(key(row)), ...row });
    return Array.from(out.values());
  };
  const removedVotes = new Set(writes.votes.remove);
  const removedBoard = new Set(writes.board.remove);
  // An entry removal deletes the entry with its votes, board and runtime.
  const gone = new Set(writes.entryRemovals.map((r) => r.id));
  const results = writes.results;
  const won = new Map(results.winnerEntries.map((w) => [w.id, w]));
  const competitionChange = results.competition;
  return {
    ...target,
    competition: competitionChange
      ? {
          ...target.competition,
          lifecycle:
            competitionChange.lifecycle ?? target.competition.lifecycle,
          decisionConfig:
            competitionChange.nextDecisionTime === undefined
              ? target.competition.decisionConfig
              : {
                  ...target.competition.decisionConfig,
                  next_decision_time: competitionChange.nextDecisionTime
                }
        }
      : target.competition,
    entries: [
      ...target.entries.filter((e) => !gone.has(e.id)),
      ...writes.nativeEntries.map((w) => ({
        id: w.entryRowId,
        dropId: w.dropId,
        submitterId: w.authorId,
        status: 'ACTIVE',
        configVersion: w.configVersion,
        submittedAt: w.createdAt,
        withdrawnAt: null,
        disqualifiedAt: null,
        wonAt: null,
        rank: null,
        decisionId: null
      }))
    ].map((e) => {
      const win = won.get(e.id);
      if (win && (e.status === 'ACTIVE' || e.status === 'WINNER')) {
        return {
          ...e,
          status: 'WINNER',
          wonAt: win.wonAt,
          rank: win.rank,
          decisionId: win.decisionId
        };
      }
      return e;
    }),
    decisions: upsert(
      target.decisions,
      results.decisions.map((d) => ({
        id: d.id,
        scheduledAt: d.scheduledAt,
        decidedAt: d.decidedAt,
        status: d.status,
        executionKey: d.executionKey,
        createdAt: d.createdAt
      })),
      (d) => d.id
    ),
    winners: upsert(
      target.winners,
      results.winners.map((w) => ({
        decisionId: w.decisionId,
        entryId: w.entryId,
        rank: w.rank,
        finalRating: w.finalRating
      })),
      (w) => `${w.decisionId}|${w.entryId}`
    ),
    winnerVotes: upsert(
      target.winnerVotes,
      results.winnerVotes,
      (v) => `${v.decisionId}|${v.entryId}|${v.voterProfileId}`
    ),
    awards: upsert(
      target.awards,
      results.awards.map((a) => ({
        id: a.id,
        decisionId: a.decisionId,
        entryId: a.entryId,
        outcomePosition: a.outcomePosition
      })),
      (a) => a.id
    ),
    votes: upsert(
      target.votes.filter(
        (v) => !removedVotes.has(v.id) && !gone.has(v.entryId)
      ),
      writes.votes.upsert.map((v) => {
        const stored = target.votes.find(
          (s) =>
            s.entryId === v.entryId && s.voterProfileId === v.voterProfileId
        );
        // On a duplicate key, only value, credit and updated_at change.
        return stored
          ? {
              ...stored,
              value: v.value,
              creditSpent: v.creditSpent,
              updatedAt: v.updatedAt
            }
          : v;
      }),
      (v) => `${v.entryId}|${v.voterProfileId}`
    ),
    runtime: upsert(
      target.runtime.filter((r) => !gone.has(r.entryId)),
      writes.runtime.upsert,
      (r) => r.entryId
    ),
    board: upsert(
      target.board.filter(
        (b) => !removedBoard.has(b.entryId) && !gone.has(b.entryId)
      ),
      writes.board.upsert,
      (b) => b.entryId
    )
  };
}
