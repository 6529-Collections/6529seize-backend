/** Permanent native-backed compatibility view shapes; no physical schema registration. */
export interface DropVoteCreditSpending {
  readonly id: number;
  readonly voter_id: string;
  readonly drop_id: string;
  readonly credit_spent: number;
  readonly created_at: number;
  readonly wave_id: string;
}
