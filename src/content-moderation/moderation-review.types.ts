import { createHash } from 'node:crypto';

export const MODERATION_SUBJECTS = [
  'REP_CATEGORY',
  'PROFILE_BIO',
  'GROUP_NAME',
  'DROP'
] as const;
export type ModerationSubject = (typeof MODERATION_SUBJECTS)[number];
export const MODERATION_ACTIONS = [
  'REEVALUATE',
  'ALLOW',
  'BLOCK',
  'REVOKE_OVERRIDE',
  'MARK_REVIEWED',
  'SUPPRESS',
  'RESTORE',
  'QUARANTINE',
  'REMOVE',
  'SUSPEND',
  'REINSTATE'
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];
export type ModerationOutcome = 'ALLOW' | 'REJECT' | 'ERROR' | 'PENDING';
export type ModerationPolicyFamily = 'PUBLIC_FIELDS' | 'WAVE_CONTENT';
export function moderationText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
export function reportReviewOutcome(
  recommendation: string | null,
  unavailable = false
): ModerationOutcome {
  if (!recommendation || unavailable) return 'ERROR';
  return recommendation === 'NO_VIOLATION_DETECTED' ? 'ALLOW' : 'REJECT';
}
export interface ModerationInput {
  subject_type: ModerationSubject;
  subject_id: string;
  author_profile_id: string | null;
  actor_profile_id: string | null;
  operation: string;
  policy_family: ModerationPolicyFamily;
  policy_version: string;
  scope: Record<string, unknown>;
  evidence: Record<string, unknown>;
}
export interface ModerationItem extends Omit<ModerationInput, 'evidence'> {
  id: string;
  content_fingerprint: string;
  evidence: Record<string, unknown> | null;
  outcome: ModerationOutcome;
  trigger: string;
  review_status: 'NEEDS_REVIEW' | 'REVIEWED';
  override: 'ALLOW' | 'BLOCK' | null;
  permit_expires_at: number | null;
  permit_consumed_at: number | null;
  published_subject_id: string | null;
  suppressed: boolean;
  version: number;
  created_at: number;
  updated_at: number;
  evidence_expires_at: number | null;
}
export interface ModerationEvaluation {
  id: string;
  item_id: string;
  retry_of: string | null;
  trigger: string;
  outcome: ModerationOutcome;
  provider: string | null;
  model: string | null;
  policy_version: string;
  result: Record<string, unknown> | null;
  cache_hit: boolean;
  fallback: string | null;
  started_at: number;
  completed_at: number | null;
}
export interface ModerationFilter {
  subject_type?: ModerationSubject;
  outcome?: ModerationOutcome;
  policy_family?: ModerationPolicyFamily;
  trigger?: string;
  review_status?: string;
  from?: number;
  to?: number;
  profile_id?: string;
  subject_id?: string;
  before?: string;
  limit: number;
}
export function moderationFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, nested) =>
        nested && typeof nested === 'object' && !Array.isArray(nested)
          ? Object.fromEntries(
              Object.entries(nested).sort(([a], [b]) =>
                a.localeCompare(b, 'en')
              )
            )
          : nested
      )
    )
    .digest('hex');
}
export function suppressionKey(id: string, revision: string): string {
  return `${id}:${revision}`;
}
export function moderationItemId(input: ModerationInput): string {
  const revisionScope = Object.fromEntries(
    Object.entries(input.scope).filter(
      ([key]) =>
        ![
          'report_id',
          'report_reason',
          'published_revision',
          'save_request_id',
          'save_subject_id',
          'permit_generation',
          'acting_as_profile_id',
          'deterministic_signal'
        ].includes(key)
    )
  );
  return moderationFingerprint({
    subject_type: input.subject_type,
    subject_id: input.subject_id,
    author_profile_id: input.author_profile_id,
    operation: input.operation,
    policy_family: input.policy_family,
    scope: revisionScope,
    evidence: input.evidence
  });
}
