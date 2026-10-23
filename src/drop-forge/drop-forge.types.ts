export const DROP_FORGE_PLAN_VERSION = 4;
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
  | 'FAILED'
  | 'CANCELLED';
export interface LaunchPhase {
  name: string;
  start: number;
  end: number;
  price_wei: string;
  root: string;
}
export interface RecoveryAttempt {
  id: string;
  operation: 'ORIGINAL' | 'SPEED_UP' | 'CANCEL';
  requested_by: string;
  requested_at: number;
  unsigned_tx?: string;
  signed_tx?: string;
  hash?: string;
}
export interface RecoveryLedger {
  resume_scheduled?: boolean;
  nonce: number;
  cancel_requested: boolean;
  attempts: RecoveryAttempt[];
  outcome?: 'EXECUTED' | 'CANCELLED' | 'REVERTED';
  winner_hash?: string;
  supply?: number;
  block_number?: number;
  block_hash?: string;
}
export interface LaunchAction {
  disabled_revision?: number;
  disabled_reason?: string;
  payment?: {
    recipient: string;
    amount_wei: string;
    paid_count: number;
    subscriptions_count: number;
  };
  attempt_count?: number;
  attempt_error?: string;
  retry_at?: number;
  window_reported?: boolean;
  recovery?: RecoveryLedger;
  recovery_history?: RecoveryLedger[];
  recovery_requests?: Array<{
    id: string;
    operation: string;
    wallet: string;
    expected_hash: string;
    transaction_hash?: string;
  }>;
  late_delivery?: boolean;
  id: string;
  kind: 'INITIALIZE' | 'AIRDROP' | 'UPDATE' | 'METADATA' | 'PAY_ARTIST';
  label?: string;
  target_metadata?: string;
  observed?: boolean;
  manual_hashes?: string[];
  phase: number;
  due: number;
  deadline: number;
  recipients: Array<{ address: string; amount: number }>;
  state: ActionState;
  expected_supply?: number;
  airdrop_baseline?: number;
  remaining_recipients?: Array<{ address: string; amount: number }>;
  credited_tokens?: number;
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
  plan_version?: number;
  managed?: boolean;
  completion_flags?: string[];
  manual_transactions?: Array<{
    hash: string;
    state: 'PENDING' | 'CONFIRMED' | 'FAILED';
    action?: string;
    method?: string;
    phase?: number;
    metadata?: string;
    block_hash?: string;
    block_number?: number;
  }>;
  manual_lease?: {
    id: string;
    wallet: string;
    action?: string;
    previous_state: LaunchState;
    nonce: number;
  };
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

export class LaunchRpcUnavailableError extends LaunchSafetyError {}

export function assertPhaseScopedPlan(data: LaunchData): void {
  if (data.plan_version !== DROP_FORGE_PLAN_VERSION)
    throw new LaunchSafetyError(
      'Legacy launch plan lacks the current phase/research workflow; recreate an unstarted draft or reconcile started work manually'
    );
}
