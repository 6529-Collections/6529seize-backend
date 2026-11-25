import { createHash } from 'node:crypto';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  legacyCompetitionDecisionId,
  legacyCompetitionEntryId,
  stableUuid
} from '@/competitions/competition-id';

/**
 * How the chain's objects are named in 6529.io's tables.
 *
 * - An imported object (one with a legacy id) keeps 6529.io's id: a wave its
 *   `waves.id`, a decision its `competitions.id`, an entry its drop's id.
 * - A decision made on the chain is stored under a UUIDv5 of its chain id:
 *   `competitions.id` and every competition id column are varchar(36), and
 *   the v3 routes take UUIDs.
 * - A wave, drop or group made on the chain keeps its chain id (`0x` and 64
 *   hex digits fits varchar(100) and up). An entry made on the chain is a
 *   drop with id = the chain entry id; its `competition_entries.id` is
 *   derived from the competition and that drop id, as for 6529.io's own
 *   entries in a wave's primary competition.
 * - A result is the runtime's decision row for that result time.
 */

/** The UUIDv5 namespace of decisions made on the chain. */
export const NS_CHAIN_DECISION = '3f0c9c64-7a6d-5b1e-9a43-2d6b0f6e5c17';

const CHAIN_ID = /^0x[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A chain id (0x and 64 hex digits), lowercase; null for anything else. */
export function chainIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.toLowerCase();
  return CHAIN_ID.test(id) ? id : null;
}

/**
 * A legacy id as 6529.io writes UUIDs (lowercase, with dashes); the chain
 * answers them that way, with or without dashes. Null for anything else.
 */
export function legacyIdOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const text = value.toLowerCase();
  if (UUID.test(text)) return text;
  if (/^[0-9a-f]{32}$/.test(text)) {
    return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
  }
  return null;
}

/** 6529.io's id of a decision made on the chain. */
export function nativeCompetitionId(decisionId: string): string {
  return stableUuid(NS_CHAIN_DECISION, decisionId.toLowerCase());
}

/** 6529.io's competition id of a chain decision. */
export function competitionIdOf(decision: {
  readonly decisionId: string;
  readonly legacyId: string | null;
}): string {
  return decision.legacyId ?? nativeCompetitionId(decision.decisionId);
}

/** The drop id of an entry: its legacy id, else its chain id. */
export function entryDropIdOf(entry: {
  readonly entryId: string;
  readonly legacyId: string | null;
}): string {
  return entry.legacyId ?? entry.entryId.toLowerCase();
}

/** `competition_entries.id` of an entry made on the chain. */
export function nativeEntryRowId(
  competitionId: string,
  entryId: string
): string {
  return legacyCompetitionEntryId(competitionId, entryId.toLowerCase());
}

/** `competition_decisions.id` of a result: the runtime's derivation. */
export function resultDecisionId(
  competitionId: string,
  resultTime: number
): string {
  return legacyCompetitionDecisionId(competitionId, resultTime);
}

/** `competition_votes.id` of a vote the mirror writes first. */
export function voteRowId(
  competitionId: string,
  entryRowId: string,
  voterProfileId: string
): string {
  return stableUuid(competitionId, `vote:${entryRowId}:${voterProfileId}`);
}

/** `competition_outcome_awards.id`: the runtime's derivation. */
export function awardRowId(
  decisionRowId: string,
  entryRowId: string,
  outcomePosition: number
): string {
  return stableUuid(decisionRowId, `award:${entryRowId}:${outcomePosition}`);
}

/** `competition_lifecycle_events.id` of a lifecycle the chain moved to. */
export function lifecycleEventId(
  competitionId: string,
  lifecycle: string
): string {
  return stableUuid(competitionId, `lifecycle:chain:${lifecycle}`);
}

/** The prefix of the execution key of every result the mirror writes. */
export const CHAIN_EXECUTION_KEY_PREFIX = 'chain:';
const EXECUTION_KEY_LENGTH = 160;

/**
 * `competition_decisions.execution_key` of a chain result:
 * `chain:<network>:<decisionId>:<resultTime>`. A network id too long for
 * the column is replaced by `h` and the first 32 hex digits of its sha256.
 */
export function chainExecutionKey(
  network: string | null,
  decisionId: string,
  resultTime: number
): string {
  return `${chainExecutionKeyPrefix(network)}${decisionId.toLowerCase()}:${resultTime}`;
}

/** The execution keys of one network's results start with this. */
export function chainExecutionKeyPrefix(network: string | null): string {
  const tail = `:0x${'0'.repeat(64)}:${Number.MAX_SAFE_INTEGER}`;
  let net = network ?? '';
  if (
    CHAIN_EXECUTION_KEY_PREFIX.length + net.length + tail.length >
      EXECUTION_KEY_LENGTH ||
    !/^[A-Za-z0-9._-]*$/.test(net)
  ) {
    net = `h${createHash('sha256').update(net).digest('hex').slice(0, 32)}`;
  }
  return `${CHAIN_EXECUTION_KEY_PREFIX}${net}:`;
}

/** Whether a decision row is one the mirror wrote. */
export function isChainExecutionKey(key: string | null | undefined): boolean {
  return !!key && key.startsWith(CHAIN_EXECUTION_KEY_PREFIX);
}

/** The UUIDv5 namespace of rows the mirror derives for waves. */
export const NS_CHAIN_WAVE = 'ba8242d8-b337-49b0-89dd-43bb550868a7';

/** The UUIDv5 namespace of rows the mirror derives for groups. */
export const NS_CHAIN_GROUP = 'c9218c45-f922-4fd4-a30e-c161e4bd74d7';

/** The description drop of a wave made on the chain. */
export function waveDescriptionDropId(chainWaveId: string): string {
  return stableUuid(NS_CHAIN_WAVE, `description:${chainWaveId.toLowerCase()}`);
}

/**
 * `profile_groups.profile_group_id` of a chain group version's include or
 * exclude list, as the mirror writes it.
 */
export function groupListId(
  chainGroupId: string,
  version: number,
  list: 'include' | 'exclude'
): string {
  return stableUuid(
    NS_CHAIN_GROUP,
    `${list}:${chainGroupId.toLowerCase()}:${version}`
  );
}

const FLICKR58 = '123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const SHORT_ID_LENGTH = 22;

/**
 * A UUID as 6529.io's group ids end: its 128 bits in flickrBase58, 22
 * characters (`short-uuid`, padded with the alphabet's zero, '1').
 */
export function groupShortIdOf(uuid: string): string | null {
  const id = legacyIdOf(uuid);
  if (!id) return null;
  let n = BigInt(`0x${id.replace(/-/g, '')}`);
  let out = '';
  for (let i = 0; i < SHORT_ID_LENGTH; i++) {
    out = FLICKR58[Number(n % BigInt(58))] + out;
    n /= BigInt(58);
  }
  return out;
}

/**
 * The legacy UUID the waves import gave a 6529.io group id (the exporter's
 * `group_uuid`): the UUID its `-<short id>` tail encodes;
 * for an id that has none, the first 16 bytes of keccak256 of the id.
 */
export function legacyUuidOfGroupId(groupId: string): string {
  const tail = groupId.split('-').pop() ?? '';
  let n = BigInt(0);
  let decoded = tail.length === SHORT_ID_LENGTH;
  for (const ch of decoded ? tail : '') {
    const digit = FLICKR58.indexOf(ch);
    if (digit < 0) {
      decoded = false;
      break;
    }
    n = n * BigInt(58) + BigInt(digit);
  }
  const hex =
    decoded && n < BigInt(1) << BigInt(128)
      ? n.toString(16).padStart(32, '0')
      : keccak256(toUtf8Bytes(groupId)).slice(2, 34);
  return legacyIdOf(hex)!;
}
