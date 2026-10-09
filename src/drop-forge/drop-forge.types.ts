export type LaunchState =
  | 'DRAFT'
  | 'ARMED'
  | 'RUNNING'
  | 'PAUSED'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'CANCELLED';
export type ActionState =
  | 'PENDING'
  | 'RESERVED'
  | 'SIGNED'
  | 'CONFIRMED'
  | 'FAILED';
export interface LaunchPhase {
  name: string;
  start: number;
  end: number;
  price_wei: string;
  root: string;
}
export interface LaunchAction {
  id: string;
  kind: 'INITIALIZE' | 'AIRDROP' | 'UPDATE';
  phase: number;
  due: number;
  deadline: number;
  recipients: Array<{ address: string; amount: number }>;
  state: ActionState;
  unsigned_tx?: string;
  signed_tx?: string;
  hash?: string;
  block_number?: number;
  block_hash?: string;
}
export interface LaunchEvent {
  id: string;
  content: string;
  error: boolean;
  at: number;
  drop_id?: string;
}
export interface LaunchData {
  chain_id: number;
  contract: string;
  claim_id: number;
  signer: string;
  proxy: string;
  receiver: string;
  metadata: string;
  edition_size: number;
  distribution_hash: string;
  phases: LaunchPhase[];
  categories: string[];
  actions: LaunchAction[];
  events: LaunchEvent[];
}
export interface LaunchRecord {
  id: string;
  revision: number;
  state: LaunchState;
  error: string | null;
  data: LaunchData;
  updated_at: number;
}
export interface DistributionRow {
  phase: string;
  wallet: string;
  count: number;
  count_airdrop: number;
  count_allowlist: number;
}
export class LaunchSafetyError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

export class LaunchRevisionConflict extends LaunchSafetyError {}
