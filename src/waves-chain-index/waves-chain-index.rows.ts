import { ChainObject } from './waves-chain-index.api';

/**
 * The API's objects as index rows: the columns 6529.io's reads filter by,
 * and the whole object as `data`.
 */

export type IndexRow = Record<string, unknown>;

const ZERO_ID = `0x${'0'.repeat(64)}`;

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function lowerId(value: unknown): string | null {
  const text = str(value);
  return text ? text.toLowerCase() : null;
}

function num(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

/** A GroupRef's group, or null for no group (the zero id). */
function groupOf(ref: unknown): string | null {
  const id = lowerId((ref as ChainObject | null)?.groupId);
  return id && id !== ZERO_ID ? id : null;
}

function legacyOf(object: ChainObject): string | null {
  const legacy = str(object.legacyId);
  return legacy ? legacy.toLowerCase() : null;
}

export function waveRow(wave: ChainObject): IndexRow {
  return {
    wave_id: lowerId(wave.waveId),
    legacy_id: legacyOf(wave),
    status: str(wave.status) ?? 'open',
    members_only: !!wave.membersOnly,
    read_group_id: groupOf(wave.readGroup),
    post_group_id: groupOf(wave.postGroup),
    admin_group_id: groupOf(wave.adminGroup),
    origin: str(wave.origin) ?? 'native',
    data: wave
  };
}

export function groupRow(group: ChainObject): IndexRow {
  return {
    group_id: lowerId(group.groupId),
    legacy_id: legacyOf(group),
    version: num(group.version),
    origin: str(group.origin) ?? 'native',
    data: group
  };
}

export function roleRow(waveId: string, role: ChainObject): IndexRow {
  return {
    wave_id: waveId,
    role: str(role.role) ?? '',
    principal_id: lowerId(role.principalId),
    live: role.live !== false,
    data: role
  };
}

export function decisionRow(decision: ChainObject): IndexRow {
  return {
    decision_id: lowerId(decision.decisionId),
    legacy_id: legacyOf(decision),
    wave_id: lowerId(decision.waveId),
    status: str(decision.status) ?? '',
    kind: str(decision.kind) ?? '',
    next_result_time: num(decision.nextResultTime),
    due: !!decision.due,
    origin: str(decision.origin) ?? 'native',
    data: decision
  };
}

export function entryRow(entry: ChainObject): IndexRow {
  return {
    entry_id: lowerId(entry.entryId),
    legacy_id: legacyOf(entry),
    decision_id: lowerId(entry.decisionId),
    author: lowerId(entry.author),
    status: str(entry.status) ?? '',
    total: String(entry.total ?? '0'),
    origin: str(entry.origin) ?? 'native',
    data: entry
  };
}

export function voteRow(vote: ChainObject): IndexRow {
  return {
    decision_id: lowerId(vote.decisionId),
    entry_id: lowerId(vote.entryId),
    voter: lowerId(vote.voter),
    value: String(vote.value ?? '0'),
    updated_height: num(vote.updatedHeight)
  };
}

export function resultRow(decisionId: string, result: ChainObject): IndexRow {
  return {
    decision_id: decisionId,
    result_time: num(result.resultTime),
    status: str(result.status) ?? '',
    stage: str(result.stage) ?? '',
    origin: str(result.origin) ?? 'native',
    data: result
  };
}

export function pollRow(poll: ChainObject): IndexRow {
  return {
    poll_id: lowerId(poll.pollId),
    legacy_id: legacyOf(poll),
    wave_id: lowerId(poll.waveId),
    status: str(poll.status) ?? '',
    origin: str(poll.origin) ?? 'native',
    data: poll
  };
}

export function waveRepRow(waveId: string, rating: ChainObject): IndexRow {
  const category = rating.category;
  const categoryId =
    category && typeof category === 'object'
      ? lowerId((category as ChainObject).id)
      : lowerId(category);
  const categoryName =
    category && typeof category === 'object'
      ? str((category as ChainObject).name)
      : null;
  return {
    wave_id: waveId,
    rater: lowerId(rating.rater),
    category_id: categoryId ?? ZERO_ID,
    category_name: categoryName,
    value: num(rating.value),
    updated_height: num(rating.updatedHeight)
  };
}

export function leaderboardRow(
  decisionId: string,
  leaderboard: ChainObject
): IndexRow {
  return {
    decision_id: decisionId,
    scored_at: num(leaderboard.scoredAt),
    data: leaderboard
  };
}

/** A row the index can key: every key column set. */
export function hasKeys(row: IndexRow, keys: readonly string[]): boolean {
  return keys.every((key) => row[key] !== null && row[key] !== undefined);
}
