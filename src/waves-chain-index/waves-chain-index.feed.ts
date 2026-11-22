import { ChainFeedPage } from '@/chain-gateway/chain-gateway.types';

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
  readonly results: Map<string, { decisionId: string; resultTime: number }>;
  /** Votes as the feed gives them, applied as they are. */
  readonly votes: Map<string, VoteChange>;
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
          into.votes.set(`${decisionId}:${entryId}:${voter}`, {
            decisionId,
            entryId,
            voter,
            value:
              value && value.value !== undefined && value.value !== null
                ? String(value.value)
                : null,
            updatedHeight: Number(value?.updatedHeight ?? block.height)
          });
          into.leaderboards.add(decisionId);
          break;
        }
        case '0x060a': {
          const decisionId = id(key.id);
          const resultTime = Number(key.D);
          if (!decisionId || !Number.isFinite(resultTime)) break;
          into.results.set(`${decisionId}:${resultTime}`, {
            decisionId,
            resultTime
          });
          into.decisions.add(decisionId);
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
