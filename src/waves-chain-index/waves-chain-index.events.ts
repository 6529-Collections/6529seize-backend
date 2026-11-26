import {
  ChainFeedBlock,
  ChainFeedRecord
} from '@/chain-gateway/chain-gateway.types';

/**
 * The chain index's event log: what changed in each finalized block, for
 * 6529.io's notifications (entities/IWavesChainIndex.ts ChainEventEntity).
 *
 * The change feed gives each block's records as they stand after the block,
 * in key order, with no transaction id or index. So an event is a change of
 * state, not an operation, and its place is (height, seq): seq counts the
 * block's events in the order of its records, each record's events in a
 * fixed order. A record's events are read off the record and the block's
 * other records where the chain's rules allow it (validator chain-exec):
 *
 * - WAVE_CREATED, WAVE_POLICY_REPLACED: a WavePolicy written at its own
 *   `activationHeight`, version 1 or later. The creator is the `grantedBy`
 *   of the controller's admin grant written with it.
 * - GROUP_CREATED, GROUP_REPLACED: a GroupDef written at its
 *   `activationHeight`, version 1 or later.
 * - MODERATION: a Moderation record (only MODERATION_DECIDE writes one).
 * - ENTRY_CREATED: an Entry whose `createdMs` is the block's time, native.
 * - ENTRY_RELEASED: an Entry not ACTIVE. An entry leaves ACTIVE once, and
 *   nothing writes its record after that, so the record says the entry
 *   left in this block: WIN, WITHDRAWN or DISQUALIFIED.
 * - RESULT_FINAL: a decision's Result at stage final whose `settledHeight`
 *   is the block's (a poll's close writes one too: not an event).
 * - VOTE: a Vote whose value moved; the old value is the index's before the
 *   block (see `beforeVote`). A record whose value and `updatedHeight` are
 *   the stored ones only moved in its voter's list (a removal moves the
 *   voter's last vote into the freed place): no event. Origin:
 *   - OPERATION: a value set at the block's height (VOTE_SET sets
 *     `updatedHeight`), or a vote deleted from an ACTIVE entry of a
 *     PUBLISHED decision in a block where the vote scan did no work (no
 *     VoteReduce record, and no VoteScan record or one that shows no scan
 *     under way before or after the block).
 *   - SCAN: a value cut with `updatedHeight` kept (only the scan's cuts do
 *     that), or a vote deleted from an ACTIVE entry while the voter's
 *     reduction in that decision is still under way after the block (the
 *     scan runs before a block's transactions, and VOTE_SET is refused
 *     while it is; one that ended in the block's scan leaves a VOTE_SET to
 *     0 after it the same records).
 *   - RELEASE: a vote deleted while its entry's total stayed (no Entry
 *     record in the block), from an entry no longer ACTIVE, or in a decision
 *     no longer PUBLISHED (each vote there is released).
 *   - AMBIGUOUS: a vote deleted from an ACTIVE entry where the scan worked
 *     in the block but the voter's reduction is not under way after it: a
 *     reduction that ended inside the block, or the voter's own VOTE_SET
 *     to 0, leave the same records.
 *   The scan's state (VoteScan's `scanning` and `finishedDay`, the
 *   reduction under way) is carried from block to block and kept with the
 *   log; until the log has seen it, OPERATION needs a block without scan
 *   records.
 * - POLL_BALLOT: a PollBallot. Version 1 had no ballot before; else the old
 *   selection is the one before in the batch or the log's last one, when
 *   the versions show nothing came between.
 * - GAP: written by the service when the feed no longer holds its cursor:
 *   no events were derived from `from` to `to`.
 *
 * Same-block cases the records can't tell apart, logged as said:
 * - a voter takes a vote back and the entry then leaves ACTIVE, or the
 *   decision ends, later in the block: RELEASE;
 * - a vote cut by the scan and set again by its voter in the block: one
 *   OPERATION event from the value before the block;
 * - two VOTE_SETs, or two ballots, of one voter or cluster in a block: one
 *   event (the ballot's old choices unknown: its version moved by two);
 * - an entry created and released in the block: ENTRY_CREATED then
 *   ENTRY_RELEASED;
 * - a moderation and the entry's release: MODERATION then ENTRY_RELEASED
 *   DISQUALIFIED, whatever else the block did to the entry.
 */

/** Families the log reads that the index itself doesn't follow. */
export const EVENT_ONLY_FAMILIES = [
  '0x0506', // Moderation
  '0x0611', // VoteReduce
  '0x0612' // VoteScan
] as const;

export const CHAIN_EVENT_KINDS = [
  'WAVE_CREATED',
  'WAVE_POLICY_REPLACED',
  'GROUP_CREATED',
  'GROUP_REPLACED',
  'MODERATION',
  'ENTRY_CREATED',
  'ENTRY_RELEASED',
  'VOTE',
  'RESULT_FINAL',
  'POLL_BALLOT',
  'GAP'
] as const;
export type ChainEventKind = (typeof CHAIN_EVENT_KINDS)[number];

/** SYSTEM: the index's own event (GAP). */
export type ChainEventOrigin =
  | 'OPERATION'
  | 'SCAN'
  | 'RELEASE'
  | 'AMBIGUOUS'
  | 'SYSTEM';

/** The chain's ids an event names, each with 6529.io's legacy id if any. */
export interface ChainEventIds {
  readonly waveId: string | null;
  readonly waveLegacyId: string | null;
  readonly decisionId: string | null;
  readonly decisionLegacyId: string | null;
  readonly entryId: string | null;
  readonly entryLegacyId: string | null;
  readonly pollId: string | null;
  readonly pollLegacyId: string | null;
  readonly groupId: string | null;
  readonly groupLegacyId: string | null;
}

export interface ChainEvent extends ChainEventIds {
  readonly height: number;
  readonly seq: number;
  /** The block's time (its slot's start, ms). */
  readonly blockTime: number;
  readonly kind: ChainEventKind;
  readonly origin: ChainEventOrigin;
  /** The voter, ballot cluster, author, creator, controller or moderator. */
  readonly actor: string | null;
  readonly data: Record<string, unknown>;
}

const NO_IDS: ChainEventIds = {
  waveId: null,
  waveLegacyId: null,
  decisionId: null,
  decisionLegacyId: null,
  entryId: null,
  entryLegacyId: null,
  pollId: null,
  pollLegacyId: null,
  groupId: null,
  groupLegacyId: null
};

/**
 * The event that says the log has no events for the heights `from` to
 * `to`: the feed no longer held them. It takes the place (to, 0).
 */
export function gapEvent(
  from: number,
  to: number,
  blockTime: number
): ChainEvent {
  return {
    ...NO_IDS,
    height: to,
    seq: 0,
    blockTime,
    kind: 'GAP',
    origin: 'SYSTEM',
    actor: null,
    data: { from, to }
  };
}

// ------------------------------------------------------------ the cursor

/**
 * The cursor after an event: `height:seq`, and `@network` when the log's
 * network is known. A relaunched chain starts a new log, so a cursor of
 * another network is refused.
 */
export function eventCursor(
  event: Pick<ChainEvent, 'height' | 'seq'>,
  network: string | null = null
) {
  return `${event.height}:${event.seq}${network ? `@${network}` : ''}`;
}

export class EventCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventCursorError';
    Object.setPrototypeOf(this, EventCursorError.prototype);
  }
}

/** A cursor's place; null reads from the start. Throws on a malformed one. */
export function parseEventCursor(
  cursor: string | null | undefined
): { height: number; seq: number; network: string | null } | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  const match = /^(\d{1,16}):(\d{1,10})(?:@(.{1,100}))?$/.exec(cursor);
  const height = Number(match?.[1]);
  const seq = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(height) || !Number.isSafeInteger(seq)) {
    throw new EventCursorError(
      `${cursor}: an event cursor is height:seq[@network]`
    );
  }
  return { height, seq, network: match[3] ?? null };
}

// ------------------------------------------------------------ the context

/** What the index (or the API) holds of an object an event names. */
export interface ObjectInfo {
  readonly legacyId: string | null;
  /** An entry's decision. */
  readonly decisionId?: string | null;
  /** A decision's or a poll's wave. */
  readonly waveId?: string | null;
  /** An entry's author. */
  readonly author?: string | null;
  /**
   * An entry's total as the index last read it: what a vote released from
   * it leaves (an entry no longer ACTIVE keeps its total).
   */
  readonly total?: string | null;
  /** An entry's manifest hash (it never changes). */
  readonly manifestHash?: string | null;
  /** A decision's credit, as config codes. */
  readonly creditScope?: number | null;
  readonly creditSource?: number | null;
  /** A decision's status (the API's name) and the height it was read at. */
  readonly status?: string | null;
  readonly statusHeight?: number | null;
}

/** A vote as the index holds it. */
export interface StoredVote {
  readonly value: string;
  readonly updatedHeight: number;
  readonly generation: number;
}

export interface StoredBallot {
  readonly selection: number;
  readonly version: number;
}

export interface EventContext {
  readonly entries: Map<string, ObjectInfo>;
  readonly decisions: Map<string, ObjectInfo>;
  readonly waves: Map<string, ObjectInfo>;
  readonly polls: Map<string, ObjectInfo>;
  readonly groups: Map<string, ObjectInfo>;
  /** By `voteKey`. */
  readonly votes: Map<string, StoredVote>;
  /** The log's last ballot of each (poll, cluster) before the batch. */
  readonly ballots: Map<string, StoredBallot>;
}

export function emptyEventContext(): EventContext {
  return {
    entries: new Map(),
    decisions: new Map(),
    waves: new Map(),
    polls: new Map(),
    groups: new Map(),
    votes: new Map(),
    ballots: new Map()
  };
}

/**
 * Whether the index's votes tell what was there before a block. While a
 * full read checks every row again (the first one, or one after the feed
 * lost its cursor), a row tells only if that full read or the feed wrote
 * it, and a missing row means no vote only where the full read has been.
 * The full read never reads past the feed (the service reads it at most at
 * the feed's height), so what it read is from before any block the feed
 * has still to apply.
 */
export interface VoteTrust {
  /** No such full read under way: every row is as the feed left it. */
  readonly complete: boolean;
  /** The full read under way, or the last one. */
  readonly generation: number;
  /** Rows of this generation or later were written since the last check. */
  readonly trustFrom: number;
  /** The full read under way has read this entry's votes. */
  covers(decisionId: string, entryId: string): boolean;
}

export const TRUST_ALL: VoteTrust = {
  complete: true,
  generation: 0,
  trustFrom: 0,
  covers: () => true
};

/**
 * The vote scan as the log last saw it: VoteScan's `scanning` and
 * `finishedDay` (null: not seen yet), and the reduction under way as
 * `voter:decisionId` (null: none, or not seen yet).
 */
export interface ScanState {
  readonly scanning: number | null;
  readonly finishedDay: number | null;
  readonly reducing: string | null;
}

export const UNKNOWN_SCAN: ScanState = {
  scanning: null,
  finishedDay: null,
  reducing: null
};

/** What one batch's derivation carries in and out. */
export interface EventCarry {
  readonly scan: ScanState;
  /**
   * Votes whose records the node could not decode earlier in this run:
   * the index holds them as they were before, so their value is unknown.
   */
  readonly unknownVotes: ReadonlySet<string>;
}

export function voteKey(decisionId: string, entryId: string, voter: string) {
  return `${decisionId}:${entryId}:${voter}`;
}

export function ballotKey(pollId: string, cid: string) {
  return `${pollId}:${cid}`;
}

// ------------------------------------------------------------ records

type Fields = Record<string, unknown>;

const ZERO_ID = `0x${'0'.repeat(64)}`;
const ACTIVE = 1;
const NATIVE = 1;
const STAGE_FINAL = 3;
/** Decision status codes ENDED and ARCHIVED: every vote is released. */
const CLOSED_CODES = new Set([3, 4]);
const CLOSED_NAMES = new Set(['ended', 'archived']);

const ENTRY_STATUS: Record<number, string> = {
  1: 'active',
  2: 'winner',
  3: 'withdrawn',
  4: 'disqualified'
};
const RELEASE_REASON: Record<number, string> = {
  2: 'WIN',
  3: 'WITHDRAWN',
  4: 'DISQUALIFIED'
};
const RESULT_STATUS: Record<number, string> = {
  0: 'counting',
  1: 'skipped',
  2: 'decided',
  3: 'cancelled'
};
const DECISION_STATUS: Record<number, string> = {
  1: 'draft',
  2: 'published',
  3: 'ended',
  4: 'archived'
};
const CREDIT_SCOPE: Record<number, string> = { 1: 'decision', 2: 'entry' };
const CREDIT_SOURCE: Record<number, string> = {
  1: 'tdh',
  3: 'tdh_xtdh',
  4: 'rep'
};

function hexId(value: unknown): string | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
}

/** A non-zero id, or null. */
function setId(value: unknown): string | null {
  const key = hexId(value);
  return key && key !== ZERO_ID ? key : null;
}

function int(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function decimal(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return typeof value === 'string' && /^-?[0-9]+$/.test(value)
    ? String(BigInt(value))
    : null;
}

function named(names: Record<number, string>, code: unknown): string | null {
  const number = int(code);
  return number === null ? null : (names[number] ?? `code_${number}`);
}

function groupRefId(ref: unknown): string | null {
  return setId((ref as Fields | null)?.groupId);
}

/** The options a selection's bits choose, option 0 first. */
export function choicesOf(selection: number): number[] {
  const out: number[] = [];
  for (let option = 0; option < 32; option++) {
    if ((selection >>> option) & 1) out.push(option);
  }
  return out;
}

interface Decoded {
  readonly record: ChainFeedRecord;
  readonly family: string;
  readonly key: Fields;
  /** null: deleted in this block, or a record the node could not decode. */
  readonly value: Fields | null;
  readonly deleted: boolean;
}

function decode(record: ChainFeedRecord): Decoded {
  const deleted = record.value === null;
  const value =
    !deleted &&
    record.valueFields !== null &&
    typeof record.valueFields === 'object'
      ? (record.valueFields as Fields)
      : null;
  return {
    record,
    family: String(record.family ?? '').toLowerCase(),
    key: record.keyFields ?? {},
    value,
    deleted
  };
}

/** A block's records, decoded, and the ones others look up by id. */
interface BlockRecords {
  readonly ordered: Decoded[];
  readonly groups: Map<string, Fields>;
  readonly waves: Map<string, Fields>;
  readonly decisions: Map<string, Fields>;
  /** null: deleted or undecodable. */
  readonly entries: Map<string, Fields | null>;
  readonly polls: Map<string, Fields>;
  readonly roleGrants: Decoded[];
  /** The block's VoteReduce record, if it has one. */
  readonly voteReduce: Decoded | null;
  /** The block's VoteScan record, if it has one. */
  readonly voteScan: Decoded | null;
}

function blockRecords(block: ChainFeedBlock): BlockRecords {
  const out = {
    ordered: block.records.map(decode),
    groups: new Map<string, Fields>(),
    waves: new Map<string, Fields>(),
    decisions: new Map<string, Fields>(),
    entries: new Map<string, Fields | null>(),
    polls: new Map<string, Fields>(),
    roleGrants: [] as Decoded[],
    voteReduce: null as Decoded | null,
    voteScan: null as Decoded | null
  };
  for (const r of out.ordered) {
    const put = (map: Map<string, Fields>, field: string) => {
      const key = hexId(r.key[field]);
      if (key && r.value) map.set(key, r.value);
    };
    switch (r.family) {
      case '0x0401':
        put(out.groups, 'groupId');
        break;
      case '0x0403':
        out.roleGrants.push(r);
        break;
      case '0x0501':
        put(out.waves, 'waveId');
        break;
      case '0x0601':
        put(out.decisions, 'decisionId');
        break;
      case '0x0603': {
        const key = hexId(r.key.entryId);
        if (key) out.entries.set(key, r.value);
        break;
      }
      case '0x060b':
        put(out.polls, 'pollId');
        break;
      case '0x0611':
        out.voteReduce = r;
        break;
      case '0x0612':
        out.voteScan = r;
        break;
      default:
        break;
    }
  }
  return out;
}

/** The scan's state after a block, from the one before and its records. */
function scanAfter(before: ScanState, records: BlockRecords): ScanState {
  let { scanning, finishedDay, reducing } = before;
  const scan = records.voteScan;
  if (scan) {
    scanning = int(scan.value?.scanning);
    finishedDay = int(scan.value?.finishedDay);
    // A scan finishes only once no reduction is under way.
    if (scanning === 0) reducing = null;
  }
  const reduce = records.voteReduce;
  if (reduce) {
    const voter = hexId(reduce.value?.voter);
    const decisionId = hexId(reduce.value?.decisionId);
    reducing = voter && decisionId ? `${voter}:${decisionId}` : null;
  }
  return { scanning, finishedDay, reducing };
}

/** The ids the events of these blocks name: what to look up first. */
export interface EventLookups {
  readonly entryIds: Set<string>;
  readonly decisionIds: Set<string>;
  readonly waveIds: Set<string>;
  readonly pollIds: Set<string>;
  readonly groupIds: Set<string>;
  readonly votes: Map<
    string,
    { decisionId: string; entryId: string; voter: string }
  >;
  readonly ballots: Map<string, { pollId: string; cid: string }>;
}

export function eventLookups(blocks: readonly ChainFeedBlock[]): EventLookups {
  const out: EventLookups = {
    entryIds: new Set(),
    decisionIds: new Set(),
    waveIds: new Set(),
    pollIds: new Set(),
    groupIds: new Set(),
    votes: new Map(),
    ballots: new Map()
  };
  const add = (set: Set<string>, value: unknown) => {
    const key = hexId(value);
    if (key) set.add(key);
  };
  for (const block of blocks) {
    const records = block.records.map(decode);
    const polls = new Set(
      records
        .filter((r) => r.family === '0x060b')
        .map((r) => hexId(r.key.pollId))
    );
    for (const r of records) {
      switch (r.family) {
        case '0x0402':
          add(out.groupIds, r.key.groupId);
          break;
        case '0x0502':
          add(out.waveIds, r.key.waveId);
          break;
        case '0x0506':
          add(out.waveIds, r.key.scopeId);
          add(out.entryIds, r.key.subjectId);
          break;
        case '0x0603':
          add(out.entryIds, r.key.entryId);
          add(out.decisionIds, r.value?.decisionId);
          break;
        case '0x0607': {
          const decisionId = hexId(r.key.decisionId);
          const entryId = hexId(r.key.entryId);
          const voter = hexId(r.key.voter);
          if (!decisionId || !entryId || !voter) break;
          out.entryIds.add(entryId);
          out.decisionIds.add(decisionId);
          out.votes.set(voteKey(decisionId, entryId, voter), {
            decisionId,
            entryId,
            voter
          });
          break;
        }
        case '0x060a':
          // A poll's close writes its Result beside the Poll.
          if (!polls.has(hexId(r.key.id))) {
            add(out.decisionIds, r.key.id);
            for (const winner of Array.isArray(r.value?.winners)
              ? (r.value.winners as Fields[])
              : []) {
              add(out.entryIds, winner.entryId);
            }
          }
          break;
        case '0x060c': {
          const pollId = hexId(r.key.pollId);
          const cid = hexId(r.key.cid);
          if (!pollId || !cid) break;
          out.pollIds.add(pollId);
          out.ballots.set(ballotKey(pollId, cid), { pollId, cid });
          break;
        }
        default:
          break;
      }
    }
  }
  return out;
}

/** An object as the batch's own records give it. */
export interface BatchObject extends ObjectInfo {
  /** Created on the chain: no legacy id. */
  readonly native: boolean;
}

export interface BatchObjects {
  readonly entries: Map<string, BatchObject>;
  readonly decisions: Map<string, BatchObject>;
  readonly waves: Map<string, BatchObject>;
  readonly polls: Map<string, BatchObject>;
  readonly groups: Map<string, BatchObject>;
}

/**
 * The objects the batch's records write, as the last record leaves them:
 * a native one needs no lookup when the index doesn't hold it yet.
 */
export function batchObjects(blocks: readonly ChainFeedBlock[]): BatchObjects {
  const out: BatchObjects = {
    entries: new Map(),
    decisions: new Map(),
    waves: new Map(),
    polls: new Map(),
    groups: new Map()
  };
  for (const block of blocks) {
    for (const r of block.records.map(decode)) {
      const value = r.value;
      if (!value) continue;
      const native = int(value.origin) === NATIVE;
      const put = (
        map: Map<string, BatchObject>,
        field: string,
        info: Omit<BatchObject, 'legacyId' | 'native'> = {}
      ) => {
        const key = hexId(r.key[field]);
        if (key) map.set(key, { legacyId: null, native, ...info });
      };
      switch (r.family) {
        case '0x0401':
          put(out.groups, 'groupId');
          break;
        case '0x0501':
          put(out.waves, 'waveId');
          break;
        case '0x0601': {
          const config = (value.config ?? {}) as Fields;
          put(out.decisions, 'decisionId', {
            waveId: hexId(value.waveId),
            creditScope: int(config.creditScope),
            creditSource: int(config.creditSource),
            status: named(DECISION_STATUS, value.status),
            statusHeight: block.height
          });
          break;
        }
        case '0x0603':
          put(out.entries, 'entryId', {
            decisionId: hexId(value.decisionId),
            author: hexId(value.author),
            total: decimal(value.total),
            manifestHash: hexId(value.manifestHash)
          });
          break;
        case '0x060b':
          put(out.polls, 'pollId', { waveId: hexId(value.waveId) });
          break;
        default:
          break;
      }
    }
  }
  return out;
}

/** What earlier blocks of the batch left, before the index applies them. */
interface Overlay {
  /** null: a value the log could not tell. */
  readonly votes: Map<
    string,
    { value: string; updatedHeight: number | null } | null
  >;
  readonly ballots: Map<string, StoredBallot | null>;
  readonly entryTotals: Map<string, string | null>;
  /** Decision status codes. */
  readonly decisions: Map<string, number | null>;
  /** The scan after the last block. */
  scan: ScanState;
  readonly unknownVotes: Set<string>;
}

// ------------------------------------------------------------ derivation

export interface DerivedEvents {
  readonly events: ChainEvent[];
  /** What the next batch carries in. */
  readonly carry: EventCarry;
}

/**
 * The events of `blocks` (one batch, ascending), for the blocks at
 * `from` or above; the ones below were logged before. `context` is the
 * index as it stood before the batch, `carry` what the blocks before it
 * left.
 */
export function deriveEvents(
  blocks: readonly ChainFeedBlock[],
  from: number,
  context: EventContext,
  trust: VoteTrust,
  carry: EventCarry = { scan: UNKNOWN_SCAN, unknownVotes: new Set() }
): DerivedEvents {
  const overlay: Overlay = {
    votes: new Map(),
    ballots: new Map(),
    entryTotals: new Map(),
    decisions: new Map(),
    scan: carry.scan,
    unknownVotes: new Set(carry.unknownVotes)
  };
  const out: ChainEvent[] = [];
  for (const block of blocks) {
    const records = blockRecords(block);
    const events = new BlockEvents(block, records, context, trust, overlay);
    for (const r of records.ordered) events.add(r);
    if (block.height >= from) out.push(...events.out);
    events.carry();
  }
  return {
    events: out,
    carry: { scan: overlay.scan, unknownVotes: overlay.unknownVotes }
  };
}

class BlockEvents {
  readonly out: ChainEvent[] = [];
  private readonly carried: (() => void)[] = [];
  private readonly scanBefore: ScanState;
  private readonly scanEnd: ScanState;

  constructor(
    private readonly block: ChainFeedBlock,
    private readonly records: BlockRecords,
    private readonly context: EventContext,
    private readonly trust: VoteTrust,
    private readonly overlay: Overlay
  ) {
    this.scanBefore = overlay.scan;
    this.scanEnd = scanAfter(overlay.scan, records);
  }

  /** Leaves this block's values for the batch's later blocks. */
  carry() {
    for (const step of this.carried) step();
    for (const [decisionId, decision] of Array.from(
      this.records.decisions.entries()
    )) {
      this.overlay.decisions.set(decisionId, int(decision.status));
    }
    this.overlay.scan = this.scanEnd;
  }

  add(r: Decoded) {
    switch (r.family) {
      case '0x0402':
        return this.groupDef(r);
      case '0x0502':
        return this.wavePolicy(r);
      case '0x0506':
        return this.moderation(r);
      case '0x0603':
        return this.entry(r);
      case '0x0607':
        return this.vote(r);
      case '0x060a':
        return this.result(r);
      case '0x060c':
        return this.ballot(r);
      default:
        return undefined;
    }
  }

  private push(
    kind: ChainEventKind,
    ids: Partial<ChainEventIds>,
    actor: string | null,
    data: Record<string, unknown>,
    origin: ChainEventOrigin = 'OPERATION'
  ) {
    this.out.push({
      ...NO_IDS,
      ...ids,
      height: this.block.height,
      seq: this.out.length,
      blockTime: this.block.time,
      kind,
      origin,
      actor,
      data
    });
  }

  private writtenHere(value: Fields): boolean {
    return int(value.activationHeight) === this.block.height;
  }

  // ---------------------------------------------------------- ids

  private waveIds(waveId: string | null): Partial<ChainEventIds> {
    return {
      waveId,
      waveLegacyId: waveId
        ? (this.context.waves.get(waveId)?.legacyId ?? null)
        : null
    };
  }

  private decisionWave(decisionId: string): string | null {
    return (
      hexId(this.records.decisions.get(decisionId)?.waveId) ??
      this.context.decisions.get(decisionId)?.waveId ??
      null
    );
  }

  private decisionIds(decisionId: string | null): Partial<ChainEventIds> {
    if (!decisionId) return {};
    return {
      ...this.waveIds(this.decisionWave(decisionId)),
      decisionId,
      decisionLegacyId: this.context.decisions.get(decisionId)?.legacyId ?? null
    };
  }

  private entryDecision(entryId: string): string | null {
    return (
      hexId(this.records.entries.get(entryId)?.decisionId) ??
      this.context.entries.get(entryId)?.decisionId ??
      null
    );
  }

  private entryIds(
    entryId: string,
    decisionId: string | null = this.entryDecision(entryId)
  ): Partial<ChainEventIds> {
    return {
      ...this.decisionIds(decisionId),
      entryId,
      entryLegacyId: this.context.entries.get(entryId)?.legacyId ?? null
    };
  }

  // ---------------------------------------------------------- events

  private groupDef(r: Decoded) {
    const groupId = hexId(r.key.groupId);
    const version = int(r.key.version);
    if (!groupId || version === null || !r.value) return;
    if (!this.writtenHere(r.value)) return;
    const controller = hexId(this.records.groups.get(groupId)?.controller);
    this.push(
      version === 1 ? 'GROUP_CREATED' : 'GROUP_REPLACED',
      {
        groupId,
        groupLegacyId: this.context.groups.get(groupId)?.legacyId ?? null
      },
      controller,
      {
        version,
        controller,
        defHash: r.value.defHash ?? null,
        predicateMode: int(r.value.predicateMode),
        clauses: r.value.clauses ?? [],
        includes: r.value.includes ?? [],
        excludes: r.value.excludes ?? [],
        storedIncludes: int(r.value.storedIncludes) ?? 0,
        storedExcludes: int(r.value.storedExcludes) ?? 0
      }
    );
  }

  private wavePolicy(r: Decoded) {
    const waveId = hexId(r.key.waveId);
    const version = int(r.key.version);
    if (!waveId || version === null || !r.value) return;
    if (!this.writtenHere(r.value)) return;
    const wave = this.records.waves.get(waveId) ?? null;
    const controller = hexId(wave?.controller);
    const groups = {
      readGroupId: groupRefId(r.value.readGroup),
      postGroupId: groupRefId(r.value.postGroup),
      adminGroupId: groupRefId(r.value.adminGroup)
    };
    const groupIds = Array.from(
      new Set(
        [groups.readGroupId, groups.postGroupId, groups.adminGroupId].filter(
          (g): g is string => g !== null
        )
      )
    );
    const common = {
      policyVersion: version,
      controller,
      ...groups,
      groupIds,
      readGroup: r.value.readGroup ?? null,
      postGroup: r.value.postGroup ?? null,
      adminGroup: r.value.adminGroup ?? null,
      waveVersion: int(wave?.version),
      metadataCid: wave?.metadataCid ?? null
    };
    if (version !== 1) {
      this.push(
        'WAVE_POLICY_REPLACED',
        this.waveIds(waveId),
        controller,
        common
      );
      return;
    }
    // WAVE_CREATE grants its controller ADMIN, granted by the creator.
    const grants = this.records.roleGrants.filter(
      (g) => hexId(g.key.scopeId) === waveId && g.value
    );
    const grant =
      grants.find((g) => hexId(g.key.principalId) === controller) ??
      grants[0] ??
      null;
    const creator = hexId(grant?.value?.grantedBy) ?? controller;
    this.push('WAVE_CREATED', this.waveIds(waveId), creator, {
      ...common,
      creator,
      waveType: int(wave?.type)
    });
  }

  private moderation(r: Decoded) {
    const waveId = hexId(r.key.scopeId);
    const subjectId = hexId(r.key.subjectId);
    if (!waveId || !subjectId || !r.value) return;
    const decidedBy = hexId(r.value.decidedBy);
    this.push(
      'MODERATION',
      { ...this.entryIds(subjectId), ...this.waveIds(waveId) },
      decidedBy,
      {
        subjectId,
        action: int(r.value.action) === 1 ? 'disqualify' : r.value.action,
        version: int(r.value.version),
        policyVersion: int(r.value.policyVersion),
        until: int(r.value.until),
        decidedBy,
        reasonHash: r.value.reasonHash ?? null
      }
    );
  }

  private entry(r: Decoded) {
    const entryId = hexId(r.key.entryId);
    const value = r.value;
    if (!entryId || !value) return;
    const decisionId = hexId(value.decisionId);
    const author = hexId(value.author);
    const ids = this.entryIds(entryId, decisionId);
    const status = int(value.status);
    this.carried.push(() =>
      this.overlay.entryTotals.set(entryId, decimal(value.total))
    );
    if (
      int(value.createdMs) === this.block.time &&
      int(value.origin) === NATIVE
    ) {
      this.push('ENTRY_CREATED', ids, author, {
        author,
        createdMs: int(value.createdMs),
        manifestHash: value.manifestHash ?? null,
        contentCid: value.contentCid ?? null
      });
    }
    if (status !== null && status !== ACTIVE) {
      const config = decisionId
        ? (this.records.decisions.get(decisionId)?.config as Fields | undefined)
        : undefined;
      const stored = decisionId ? this.context.decisions.get(decisionId) : null;
      const creditScope = int(config?.creditScope) ?? stored?.creditScope;
      const creditSource = int(config?.creditSource) ?? stored?.creditSource;
      this.push('ENTRY_RELEASED', ids, author, {
        author,
        status: named(ENTRY_STATUS, status),
        reason: named(RELEASE_REASON, status),
        total: decimal(value.total),
        resultTime: int(value.resultTime) || null,
        rank: int(value.rank) || null,
        creditScope:
          creditScope === null || creditScope === undefined
            ? null
            : named(CREDIT_SCOPE, creditScope),
        creditSource:
          creditSource === null || creditSource === undefined
            ? null
            : named(CREDIT_SOURCE, creditSource)
      });
    }
  }

  /**
   * The vote as stored before this block (value and updatedHeight): from
   * the batch, else the index. undefined: no vote stored; null: unknown.
   */
  private storedVote(
    key: string
  ): { value: string; updatedHeight: number | null } | null | undefined {
    if (this.overlay.votes.has(key)) return this.overlay.votes.get(key);
    if (this.overlay.unknownVotes.has(key)) return null;
    return this.context.votes.get(key);
  }

  /** The vote before this block, or null when the index can't tell. */
  private beforeVote(
    key: string,
    decisionId: string,
    entryId: string
  ): string | null {
    if (this.overlay.votes.has(key)) {
      return this.overlay.votes.get(key)?.value ?? null;
    }
    if (this.overlay.unknownVotes.has(key)) return null;
    const row = this.context.votes.get(key);
    // A row written at or after this block holds this block's change.
    const value = (stored: StoredVote) =>
      stored.updatedHeight < this.block.height ? stored.value : null;
    const trust = this.trust;
    if (trust.complete) return row ? value(row) : '0';
    if (trust.covers(decisionId, entryId)) {
      return row && row.generation >= trust.generation ? value(row) : '0';
    }
    return row && row.generation >= trust.trustFrom ? value(row) : null;
  }

  /**
   * Whether the decision was ENDED or ARCHIVED in this block (each vote in
   * it is then released): true, false, or null when the log can't tell.
   */
  private decisionClosed(decisionId: string): boolean | null {
    const record = this.records.decisions.get(decisionId);
    if (record) return CLOSED_CODES.has(int(record.status) ?? -1);
    if (this.overlay.decisions.has(decisionId)) {
      return CLOSED_CODES.has(this.overlay.decisions.get(decisionId) ?? -1);
    }
    const stored = this.context.decisions.get(decisionId);
    if (
      !stored?.status ||
      stored.statusHeight === null ||
      stored.statusHeight === undefined ||
      stored.statusHeight >= this.block.height
    ) {
      return null;
    }
    return CLOSED_NAMES.has(stored.status);
  }

  /**
   * The voter's reduction in the decision was under way after this block,
   * so all through it: the scan runs before a block's transactions and
   * VOTE_SET is refused while it is. One under way only before the block
   * may have ended in its scan, and the voter's VOTE_SET to 0 come after.
   */
  private reduced(voter: string, decisionId: string): boolean {
    return this.scanEnd.reducing === `${voter}:${decisionId}`;
  }

  /** The vote scan did no work in this block. */
  private scanIdle(): boolean {
    if (this.records.voteReduce) return false;
    const scan = this.records.voteScan;
    if (!scan) return true;
    // VOTE_SET writes VoteScan too (a voter's first or last vote in a
    // decision): no scan worked if none was under way before or after.
    const before = this.scanBefore;
    return (
      before.scanning === 0 &&
      before.finishedDay !== null &&
      int(scan.value?.scanning) === 0 &&
      int(scan.value?.finishedDay) === before.finishedDay
    );
  }

  private vote(r: Decoded) {
    const decisionId = hexId(r.key.decisionId);
    const entryId = hexId(r.key.entryId);
    const voter = hexId(r.key.voter);
    if (!decisionId || !entryId || !voter) return;
    const key = voteKey(decisionId, entryId, voter);
    const next = r.deleted ? '0' : decimal(r.value?.value);
    const updatedHeight = r.deleted ? null : int(r.value?.updatedHeight);
    this.carried.push(() => {
      this.overlay.votes.set(
        key,
        next === null ? null : { value: next, updatedHeight }
      );
      if (next === null) this.overlay.unknownVotes.add(key);
      else this.overlay.unknownVotes.delete(key);
    });
    // A record the node could not decode: the index reads the entry's votes
    // whole.
    if (next === null) return;
    // Its value and updatedHeight as stored: it only moved in its voter's
    // list (another vote's removal), so nothing changed.
    const stored = this.storedVote(key);
    if (
      stored &&
      !r.deleted &&
      stored.value === next &&
      stored.updatedHeight === updatedHeight &&
      updatedHeight !== null &&
      updatedHeight < this.block.height
    ) {
      return;
    }
    const old = this.beforeVote(key, decisionId, entryId);
    if (old === next) return;
    const reduced = this.reduced(voter, decisionId);
    const hasEntry = this.records.entries.has(entryId);
    const blockEntry = this.records.entries.get(entryId) ?? null;
    let origin: ChainEventOrigin = 'OPERATION';
    if (r.deleted) {
      if (
        !hasEntry ||
        (blockEntry && int(blockEntry.status) !== ACTIVE) ||
        this.decisionClosed(decisionId) === true
      ) {
        origin = 'RELEASE';
      } else if (reduced) {
        origin = 'SCAN';
      } else if (!blockEntry || !this.scanIdle()) {
        origin = 'AMBIGUOUS';
      }
    } else if (updatedHeight !== null && updatedHeight < this.block.height) {
      // Only the scan's cut changes a value and keeps updatedHeight; a
      // move keeps both. Not knowing the value before, a record of a
      // voter not under reduction is taken as a move.
      if (old === null && !reduced) return;
      origin = 'SCAN';
    }
    const storedEntry = this.context.entries.get(entryId);
    const total = blockEntry
      ? decimal(blockEntry.total)
      : this.overlay.entryTotals.has(entryId)
        ? this.overlay.entryTotals.get(entryId)!
        : (storedEntry?.total ?? null);
    const author = hexId(blockEntry?.author) ?? storedEntry?.author ?? null;
    this.push(
      'VOTE',
      this.entryIds(entryId, decisionId),
      voter,
      {
        voter,
        oldValue: old,
        newValue: next,
        entryTotalAfter: total,
        entryAuthor: author,
        updatedHeight
      },
      origin
    );
  }

  private result(r: Decoded) {
    const id = hexId(r.key.id);
    const resultTime = int(r.key.D);
    const value = r.value;
    if (!id || resultTime === null || !value) return;
    if (int(value.stage) !== STAGE_FINAL) return;
    if (int(value.settledHeight) !== this.block.height) return;
    // A poll's close writes its Result with the Poll.
    if (this.records.polls.has(id) || this.context.polls.has(id)) return;
    // Each winner with its 6529.io legacy id and manifest hash (the claim
    // build for a Main Stage result needs them).
    const winners = Array.isArray(value.winners)
      ? (value.winners as Fields[]).map((w) => {
          const entryId = hexId(w.entryId);
          const stored = entryId ? this.context.entries.get(entryId) : null;
          return {
            entryId,
            rank: int(w.rank),
            score: decimal(w.score),
            legacyId: stored?.legacyId ?? null,
            manifestHash:
              (entryId &&
                hexId(this.records.entries.get(entryId)?.manifestHash)) ||
              stored?.manifestHash ||
              null
          };
        })
      : [];
    this.push('RESULT_FINAL', this.decisionIds(id), null, {
      resultTime,
      occurrence: int(value.occurrence),
      status: named(RESULT_STATUS, value.status),
      winnerCount: winners.length,
      winners,
      pauseId: int(value.pauseId) || null,
      settledHeight: this.block.height
    });
  }

  /**
   * The selection before this block: the batch's or the log's last ballot
   * when it is the version just before; two ballots of a cluster in one
   * block, or a feed gap, leave it unknown.
   */
  private beforeBallot(key: string, version: number): number | null {
    if (version === 1) return 0;
    const last = this.overlay.ballots.has(key)
      ? this.overlay.ballots.get(key)
      : this.context.ballots.get(key);
    return last && last.version === version - 1 ? last.selection : null;
  }

  private ballot(r: Decoded) {
    const pollId = hexId(r.key.pollId);
    const cid = hexId(r.key.cid);
    if (!pollId || !cid) return;
    const key = ballotKey(pollId, cid);
    const selection = int(r.value?.selection);
    const version = int(r.value?.version);
    const known = selection !== null && version !== null;
    this.carried.push(() =>
      this.overlay.ballots.set(
        key,
        known ? { selection: selection!, version: version! } : null
      )
    );
    if (!known) return;
    const old = this.beforeBallot(key, version!);
    const poll = this.context.polls.get(pollId);
    const waveId =
      hexId(this.records.polls.get(pollId)?.waveId) ?? poll?.waveId ?? null;
    this.push(
      'POLL_BALLOT',
      {
        ...this.waveIds(waveId),
        pollId,
        pollLegacyId: poll?.legacyId ?? null
      },
      cid,
      {
        cid,
        oldSelection: old,
        newSelection: selection,
        oldChoices: old === null ? null : choicesOf(old),
        newChoices: choicesOf(selection!),
        version
      }
    );
  }
}
