/** Persistence contracts only. No producers, worker or read mode is enabled. */
export type MembershipSourceScope = 'GLOBAL' | 'PROFILE';
export type MembershipSourceDimension =
  | 'TDH_XTDH' // TDH, xTDH and derived levels complete as one source cycle.
  | 'RATINGS'
  | 'OWNERSHIP'
  | 'DELEGATIONS'
  | 'GRANTS'
  | 'IDENTITY'
  | 'GROUP_CATALOG';
export type MembershipRefreshScope = 'PROFILE' | 'GROUP' | 'FULL';
export type MembershipSourceJobStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
export type MembershipRefreshRunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'SUPERSEDED'
  | 'FAILED';

/** Decimal BIGINT strings; timestamps and UUIDs are not ordering tokens. */
export interface MembershipSourceVersion {
  readonly scope: MembershipSourceScope;
  readonly target_id: string;
  readonly dimension: MembershipSourceDimension;
  readonly version: string;
}

/** Keyset cursors, never offsets; captured once per run, persisted per page. */
export interface MembershipRefreshCursor {
  readonly after_id: string | null;
  readonly through_id: string | null;
}

/** Producer-owned checkpoint, with a durable ID shared by TDH and xTDH. */
export interface MembershipSourceJobProgress {
  readonly stage: string;
  readonly after_id: string | null;
}
