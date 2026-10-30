/** Permanent native-backed compatibility view shapes; no physical schema registration. */
export interface DropVoterStateEntity {
  readonly voter_id: string;
  readonly drop_id: string;
  readonly votes: number;
  readonly wave_id: string;
}
