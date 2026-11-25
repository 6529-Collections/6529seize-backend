/**
 * The waves export writes OUT/raw in the layout and with the field names of
 * the waves snapshot tooling's fetch stage (validator repository,
 * tools/legacy-snapshot/waves_fetch.py), so its normalize and build stages
 * read 6529.io's database export as they read the public API. Values are the
 * API's own objects (the same mappers the API uses, as a guest sees them),
 * except that the export also reads what a guest can't: members-only waves,
 * hidden groups, withdrawn and disqualified entries, draft decisions.
 */

import type { StayReason } from '@/waves-scope/waves-scope';

export type Json = Record<string, unknown>;

/**
 * A wave of 6529.io, with why it stays on 6529.io (src/waves-scope): none
 * when it moves to the chain, which is when the import carries it.
 */
export interface ExportWaveRow {
  readonly id: string;
  /**
   * The reasons it stays, in STAY_REASONS order; empty when it moves.
   * A subwave under a wave that stays stays too (`parent_stays`).
   */
  readonly stay_reasons: readonly StayReason[];
  readonly parent_wave_id: string | null;
  readonly visibility_group_id: string | null;
  readonly admin_group_id: string | null;
  readonly chat_group_id: string | null;
  readonly participation_group_id: string | null;
  readonly voting_group_id: string | null;
}

/** A wave's curation (wave_curation_groups): the group it names. */
export interface ExportCuration {
  readonly id: string;
  readonly wave_id: string;
  readonly group_id: string;
}

/** One decision as the fetch stage holds it. */
export interface ExportCompetition {
  /** The `/v3/waves/{id}/competitions` item (ApiCompetition), as a guest. */
  readonly competition: Json;
  /** entries (every status), decisions (results), outcomes, pauses, versions, voters. */
  readonly details: {
    readonly entries: Json[];
    readonly decisions: Json[];
    readonly outcomes: Json[];
    readonly pauses: Json[];
    readonly versions: Json[];
    readonly voters: Json[];
  };
}

/** An ACTIVE entry of a PUBLISHED decision, for its votes and vote log. */
export interface ExportActiveEntry {
  readonly competition_id: string;
  readonly wave_id: string;
  readonly entry_id: string;
  readonly drop_id: string;
}

export interface ExportVoteLogRow {
  readonly id: string;
  /** The voter's profile id, as entry_votes.json's rows name it. */
  readonly voter_profile_id: string;
  readonly old_vote: number;
  readonly new_vote: number;
  readonly created_at: number;
}

export interface ExportWaveRepRow {
  readonly category: string;
  readonly profile_id: string;
  readonly rating: number;
  readonly last_modified: number | null;
}

export interface ExportGroupMember {
  readonly wallet: string;
  readonly key: string | null;
}

/** The device-signed events of one author-signed drop (signed/<wave>). */
export interface ExportSignedDrop {
  readonly drop_id: string;
  readonly current_event_id: string | null;
  readonly events: unknown[];
  readonly grants: Json[];
}

/** Everything the export reads. Backed by 6529.io's services; faked in tests. */
export interface WavesExportSource {
  /**
   * Every wave, by id, each with its reasons to stay (src/waves-scope), for
   * the records wave (null for none) and the waves freeze in ms (null in a
   * rehearsal: then nothing counts as made after the freeze).
   */
  listWaves(scope: {
    readonly recordsWaveId: string | null;
    readonly freezeMs: number | null;
  }): Promise<ExportWaveRow[]>;
  /** The curations of these waves: each one's id, wave and group. */
  waveCurations(waveIds: string[]): Promise<ExportCuration[]>;
  /** The `/v3/waves/{id}` configuration (ApiWave), its groups shown. */
  waveConfiguration(
    wave: ExportWaveRow,
    eligibleGroupIds: string[]
  ): Promise<Json>;
  /** Ids of every decision of these waves, any lifecycle. */
  listCompetitionIds(waveIds: string[]): Promise<string[]>;
  competition(competitionId: string): Promise<ExportCompetition | null>;
  entryVotes(entry: ExportActiveEntry): Promise<Json[]>;
  /** The entry's whole vote edit log, newest first. */
  entryVoteLog(entry: ExportActiveEntry): Promise<ExportVoteLogRow[]>;
  /** `/groups/{id}` objects (ApiGroupFull), hidden and private ones too. */
  groups(groupIds: string[]): Promise<Record<string, Json>>;
  /** The wallets of an include or exclude list. */
  identityGroupWallets(identityGroupId: string): Promise<string[]>;
  /** A group's members now, as 6529.io's membership rule gives them. */
  groupMembers(group: Json): Promise<ExportGroupMember[]>;
  /** A handle or profile id to its profile id, null when none. */
  profileIdOf(identityKey: string): Promise<string | null>;
  /** Non-zero wave REP given to these waves. */
  waveRep(waveIds: string[]): Promise<Record<string, ExportWaveRepRow[]>>;
  /** The drops (ApiDropV2) holding the wave's polls in that state. */
  wavePolls(
    waveId: string,
    state: 'OPEN' | 'CLOSED',
    nowMillis: number
  ): Promise<Json[]>;
  /**
   * The wave's drops, newest serial first, a page at a time, as the public
   * feed maps them for a guest (ApiDropWithoutWave). Replies included.
   */
  wavePagesOfDrops(waveId: string, pageSize: number): AsyncIterable<Json[]>;
  /**
   * Signed events of these drops (author-signed drops of one page), as the
   * public batch read and its single read for truncated drops give them.
   */
  signedEvents(drops: Json[]): Promise<ExportSignedDrop[]>;
}
