export interface VoteForDropModel {
  readonly voter_id: string;
  readonly drop_id: string;
  readonly wave_id: string;
  readonly votes: number;
  readonly proxy_id: string | null;
}
