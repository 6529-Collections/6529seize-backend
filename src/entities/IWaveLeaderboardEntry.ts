/** Permanent native-backed compatibility view shapes; no physical schema registration. */
export interface WaveLeaderboardEntryEntity {
  readonly drop_id: string;
  readonly wave_id: string;
  readonly timestamp: number;
  readonly vote: number;
  readonly vote_on_decision_time: number;
  readonly over_threshold_since_ms: number | null;
}
