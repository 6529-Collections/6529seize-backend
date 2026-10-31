import { ApiE2eeTrustAndSafetyReport } from '@/api/generated/models/ApiE2eeTrustAndSafetyReport';
import { ApiE2eeTrustAndSafetyReportPage } from '@/api/generated/models/ApiE2eeTrustAndSafetyReportPage';
import { E2EE_RETENTION } from '@/e2ee/e2ee.constants';
import { E2eeDb, E2eeReviewReportRow } from '@/e2ee/e2ee.db';
import { ConnectionWrapper } from '@/sql-executor';
import { fromMysqlBase64 } from '@/e2ee/e2ee-encoding';
import { e2eeErrors } from '@/e2ee/e2ee-errors';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';

// Reported encrypted messages are reviewed by the content moderators, the
// same people who work the content-moderation queue (owner decision for
// launch), and additionally by members of E2EE_TRUST_AND_SAFETY_GROUP_ID
// when it is set. Wave moderators have no access. Every read or change is
// written to e2ee_report_access_log before the response leaves, so there is
// no unaudited read. Logs carry report ids and counts, never content.

const logger = Logger.get('E2EE_TRUST_AND_SAFETY');

export const E2EE_TRUST_AND_SAFETY_DEFAULT_PAGE = 50;

export type E2eeReportAccessAction = 'list' | 'read' | 'hold' | 'release';

export interface E2eeTrustAndSafetyDeps {
  readonly db: Pick<
    E2eeDb,
    | 'listReportsForReview'
    | 'getReportForReview'
    | 'setReportHold'
    | 'insertReportAccess'
    | 'executeNativeQueriesInTransaction'
  >;
  readonly now: () => number;
  /** The content-moderation moderator check, for the acting profile. */
  readonly isModerator: (
    profileId: string,
    ctx: RequestContext
  ) => Promise<boolean>;
  /** The optional additional review group id, or null while none is set. */
  readonly groupId: () => string | null;
  readonly isGroupMember: (
    profileId: string,
    groupId: string
  ) => Promise<boolean>;
}

const asBool = (value: number | boolean): boolean =>
  value === true || value === 1;

export function toApiE2eeTrustAndSafetyReport(
  row: E2eeReviewReportRow
): ApiE2eeTrustAndSafetyReport {
  const onHold = asBool(row.on_hold);
  const createdAt = Number(row.created_at);
  return {
    id: row.id,
    group: row.group_handle,
    epoch: Number(row.epoch),
    category: row.reason,
    body: fromMysqlBase64(row.body_b64) ?? '',
    signature: row.signature,
    sender_device_key: row.sender_device_key,
    sender_profile_id: row.sender_profile_id,
    reporter_device_key: row.reporter_device_key,
    reporter_profile_id: row.reporter_profile_id,
    notes: row.notes,
    verified: asBool(row.verified),
    on_hold: onHold,
    created_at: createdAt,
    expires_at: onHold ? null : createdAt + E2EE_RETENTION.reportsMs
  };
}

export class E2eeTrustAndSafetyService {
  constructor(private readonly deps: E2eeTrustAndSafetyDeps) {}

  async listReports(
    viewerProfileId: string,
    query: {
      before?: number | undefined;
      before_id?: string | undefined;
      limit?: number | undefined;
    },
    ctx: RequestContext = {}
  ): Promise<ApiE2eeTrustAndSafetyReportPage> {
    await this.requireReviewer(viewerProfileId, ctx);
    const limit = query.limit ?? E2EE_TRUST_AND_SAFETY_DEFAULT_PAGE;
    const rows = await this.deps.db.listReportsForReview(
      query.before === undefined
        ? null
        : { beforeMs: query.before, beforeId: query.before_id ?? null },
      limit + 1
    );
    const page = rows.slice(0, limit);
    await this.audit(
      viewerProfileId,
      'list',
      page.map((row) => row.id)
    );
    const last = rows.length > limit ? page.at(-1) : undefined;
    return {
      items: page.map(toApiE2eeTrustAndSafetyReport),
      next_before: last ? Number(last.created_at) : null,
      next_before_id: last ? last.id : null
    };
  }

  async getReport(
    viewerProfileId: string,
    reportId: string,
    ctx: RequestContext = {}
  ): Promise<ApiE2eeTrustAndSafetyReport> {
    await this.requireReviewer(viewerProfileId, ctx);
    const row = await this.deps.db.getReportForReview(reportId);
    if (!row) throw e2eeErrors.notFound('Report');
    await this.audit(viewerProfileId, 'read', [reportId]);
    return toApiE2eeTrustAndSafetyReport(row);
  }

  async setHold(
    viewerProfileId: string,
    reportId: string,
    onHold: boolean,
    ctx: RequestContext = {}
  ): Promise<ApiE2eeTrustAndSafetyReport> {
    await this.requireReviewer(viewerProfileId, ctx);
    // The change and its audit row commit together or not at all.
    const row = await this.deps.db.executeNativeQueriesInTransaction(
      async (connection) => {
        if (!(await this.deps.db.setReportHold(reportId, onHold, connection))) {
          throw e2eeErrors.notFound('Report');
        }
        await this.audit(
          viewerProfileId,
          onHold ? 'hold' : 'release',
          [reportId],
          connection
        );
        return this.deps.db.getReportForReview(reportId, connection);
      }
    );
    if (!row) throw e2eeErrors.notFound('Report');
    return toApiE2eeTrustAndSafetyReport(row);
  }

  /** Content moderators, or members of the optional additional group. */
  private async requireReviewer(
    viewerProfileId: string,
    ctx: RequestContext
  ): Promise<void> {
    if (await this.deps.isModerator(viewerProfileId, ctx)) return;
    const groupId = this.deps.groupId();
    if (groupId && (await this.deps.isGroupMember(viewerProfileId, groupId))) {
      return;
    }
    throw e2eeErrors.forbidden('Moderator access is required');
  }

  private async audit(
    viewerProfileId: string,
    action: E2eeReportAccessAction,
    reportIds: readonly string[],
    connection?: ConnectionWrapper<unknown>
  ): Promise<void> {
    await this.deps.db.insertReportAccess(
      {
        viewer_profile_id: viewerProfileId,
        action,
        report_ids: reportIds.join(','),
        created_at: this.deps.now()
      },
      connection
    );
    logger.info(
      `[E2EE_REPORT_ACCESS] viewer=${viewerProfileId} action=${action} reports=${reportIds.length}`
    );
  }
}
