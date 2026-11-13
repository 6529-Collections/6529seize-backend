import {
  CONTENT_MODERATION_ITEMS_TABLE,
  CONTENT_MODERATION_REPORTS_TABLE
} from '@/constants';
import { ModerationSubject } from './moderation-review.types';

// Hash the subject identity across published revisions and reports. Rejected
// new-post submissions retain their check identity until a post is published.
// REP category text must never be carried in navigation URLs.
export function moderationCaseIdSql(prefix = ''): string {
  return `sha2(concat(${prefix}subject_type, ':', case when ${prefix}subject_type='DROP' and ${prefix}operation='CREATE' and ${prefix}published_subject_id is null then ${prefix}id else coalesce(${prefix}published_subject_id, ${prefix}subject_id) end), 256)`;
}

// Compare the JSON flag as text. Comparing a COALESCE-wrapped JSON boolean
// with SQL false can coerce both true and false to zero and include admin work.
export function moderationNonAdministrativeSql(): string {
  return "coalesce(json_unquote(json_extract(scope,'$.administrative')),'false')<>'true'";
}

// All consumers (queue, summary, sidebar) derive their cases from this same set.
// UNION ALL retains each pending requirement so a case survives until all of its
// open reports and pending checks are handled. In-flight evaluations are not
// manual work until they finish or enter the existing failure-recovery flow. Grouping happens before paging.
export function moderationCaseWorkSql(): string {
  return `select ${moderationCaseIdSql()} case_id, subject_type,
      id check_id, null report_id, created_at
    from ${CONTENT_MODERATION_ITEMS_TABLE}
    where review_status='NEEDS_REVIEW' and outcome<>'PENDING'
      and ${moderationNonAdministrativeSql()}
    union all
    select sha2(concat('DROP:',drop_id),256) case_id, 'DROP' subject_type,
      null check_id, id report_id, created_at
    from ${CONTENT_MODERATION_REPORTS_TABLE} where status='OPEN'`;
}

export interface ModerationReviewCase {
  id: string;
  subject_type: ModerationSubject;
  open_report_count: number;
  pending_check_count: number;
  check_id: string | null;
  report_id: string | null;
  created_at: number;
  preview: string | null;
  check_outcome: string | null;
  report_reason: string | null;
  drop_id: string | null;
  wave_id: string | null;
  drop_deleted: boolean;
}
