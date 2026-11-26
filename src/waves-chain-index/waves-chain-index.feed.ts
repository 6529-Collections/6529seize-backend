import { ChainFeedPage } from '@/chain-gateway/chain-gateway.types';
import { compareCodeUnits } from './waves-chain-index.order';

/**
 * The rule-version-7 families the index follows in the change feed
 * (validator crates/chain-state keys.rs; WAVES-API.md "The change feed"),
 * and what a record of each tells the index to read again.
 */
export const WAVES_FEED_FAMILIES = [
  '0x0401', // Group
  '0x0402', // GroupDef
  '0x0403', // RoleGrant
  '0x0404', // GroupMember
  '0x0501', // Wave
  '0x0502', // WavePolicy
  '0x0601', // Decision
  '0x0602', // Pause
  '0x0603', // Entry
  '0x0604', // EntryHistory
  '0x0607', // Vote
  '0x060a', // Result
  '0x060b', // Poll
  '0x060c', // PollBallot
  '0x060d', // DecisionPolicy
  '0x0613', // PollCount (a wave's openPolls)
  '0x0614', // PauseAt
  '0x0701' // Rating (wave REP: target kind 2)
] as const;

/** A rating's target kind for a wave (wave REP). */
export const WAVE_TARGET_KIND = 2;

export interface VoteChange {
  readonly decisionId: string;
  readonly entryId: string;
  readonly voter: string;
  /** null: the vote was deleted. */
  readonly value: string | null;
  readonly updatedHeight: number;
}

/** What a feed page changed, by object to read again. */
export interface FeedEffects {
  readonly groups: Set<string>;
  readonly waves: Set<string>;
  readonly roleWaves: Set<string>;
  readonly repWaves: Set<string>;
  readonly decisions: Set<string>;
  readonly entries: Set<string>;
  readonly polls: Set<string>;
  /**
   * Result[(id, D)]: a decision's result, or a closed poll's (the chain keeps
   * both in one family; the index tells them apart by reading).
   */
  readonly results: Map<string, { id: string; resultTime: number }>;
  /** Votes as the feed gives them, applied as they are. */
  readonly votes: Map<string, VoteChange>;
  /** Entries whose vote records the feed could not decode: read whole. */
  readonly voteEntries: Set<string>;
  /** Decisions whose leaderboard moved (votes, entries). */
  readonly leaderboards: Set<string>;
}

export function emptyFeedEffects(): FeedEffects {
  return {
    groups: new Set(),
    waves: new Set(),
    roleWaves: new Set(),
    repWaves: new Set(),
    decisions: new Set(),
    entries: new Set(),
    polls: new Set(),
    results: new Map(),
    votes: new Map(),
    voteEntries: new Set(),
    leaderboards: new Set()
  };
}

function id(value: unknown): string | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function add(set: Set<string>, value: unknown) {
  const key = id(value);
  if (key) set.add(key);
}

/**
 * Effects split into parts of about `size` reads each, in a fixed order
 * (so a block's parts are the same on every run); its votes, which read
 * nothing, go with the first part.
 */
export function splitFeedEffects(
  effects: FeedEffects,
  size: number
): FeedEffects[] {
  const sets = [
    'groups',
    'waves',
    'roleWaves',
    'repWaves',
    'decisions',
    'entries',
    'polls',
    'voteEntries',
    'leaderboards'
  ] as const;
  const items: { add: (into: FeedEffects) => void }[] = [];
  for (const field of sets) {
    for (const id of Array.from(effects[field]).sort(compareCodeUnits)) {
      items.push({ add: (into) => into[field].add(id) });
    }
  }
  for (const [key, result] of Array.from(effects.results.entries()).sort(
    ([a], [b]) => compareCodeUnits(a, b)
  )) {
    items.push({ add: (into) => into.results.set(key, result) });
  }
  const parts: FeedEffects[] = [];
  for (let i = 0; i < items.length || parts.length === 0; i += size) {
    const part = emptyFeedEffects();
    for (const item of items.slice(i, i + size)) item.add(part);
    parts.push(part);
  }
  for (const [key, vote] of Array.from(effects.votes.entries())) {
    parts[0].votes.set(key, vote);
  }
  return parts;
}

/** Every record of the page, in order, folded into what to read again. */
export function feedEffects(
  page: Pick<ChainFeedPage, 'blocks'>,
  into: FeedEffects = emptyFeedEffects()
): FeedEffects {
  for (const block of page.blocks) {
    for (const record of block.records) {
      const family = String(record.family ?? '').toLowerCase();
      const key = record.keyFields ?? {};
      const value = record.valueFields ?? null;
      const deleted = record.value === null;
      switch (family) {
        case '0x0401':
        case '0x0402':
        case '0x0404':
          add(into.groups, key.groupId);
          break;
        case '0x0403':
          add(into.roleWaves, key.scopeId);
          break;
        case '0x0501':
        case '0x0502':
        case '0x0613':
          add(into.waves, key.waveId);
          break;
        case '0x0601':
        case '0x0602':
        case '0x060d':
        case '0x0614':
          add(into.decisions, key.decisionId);
          add(into.leaderboards, key.decisionId);
          break;
        case '0x0603':
        case '0x0604':
          add(into.entries, key.entryId);
          break;
        case '0x0607': {
          const decisionId = id(key.decisionId);
          const entryId = id(key.entryId);
          const voter = id(key.voter);
          if (!decisionId || !entryId || !voter) break;
          into.leaderboards.add(decisionId);
          const voteKey = `${decisionId}:${entryId}:${voter}`;
          const set =
            !deleted &&
            value?.value !== undefined &&
            value?.value !== null &&
            Number.isSafeInteger(Number(value?.updatedHeight));
          if (!deleted && !set) {
            // A record the node could not decode: read the entry's votes.
            into.votes.delete(voteKey);
            into.voteEntries.add(entryId);
            break;
          }
          into.votes.set(voteKey, {
            decisionId,
            entryId,
            voter,
            value: set ? String(value?.value) : null,
            updatedHeight: set ? Number(value?.updatedHeight) : block.height
          });
          break;
        }
        case '0x060a': {
          const resultId = id(key.id);
          const resultTime = Number(key.D);
          if (!resultId || !Number.isSafeInteger(resultTime)) break;
          into.results.set(`${resultId}:${resultTime}`, {
            id: resultId,
            resultTime
          });
          break;
        }
        case '0x060b':
        case '0x060c':
          add(into.polls, key.pollId);
          break;
        case '0x0701':
          if (Number(key.targetKind) === WAVE_TARGET_KIND) {
            add(into.repWaves, key.target);
          }
          break;
        default:
          break;
      }
    }
  }
  return into;
}
