/** Permanent native-backed compatibility view shapes; no physical schema registration. */
export interface DropRealVoteInTimeEntity {
  readonly id: number;
  readonly drop_id: string;
  readonly wave_id: string;
  readonly timestamp: number;
  readonly vote: number;
}

export type DropRealVoteInTimeWithoutId = Omit<DropRealVoteInTimeEntity, 'id'>;
