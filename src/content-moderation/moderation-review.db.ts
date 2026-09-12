import { randomUUID } from 'node:crypto';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { DbPoolName } from '@/db-query.options';
import {
  BadRequestException,
  CustomApiCompliantException,
  NotFoundException
} from '@/exceptions';
import {
  CONTENT_MODERATION_ITEMS_TABLE as ITEMS,
  CONTENT_MODERATION_EVALUATIONS_TABLE as EVALUATIONS,
  CONTENT_MODERATION_AUDIT_LOG_TABLE as AUDIT,
  CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE as CHECKS,
  CIC_STATEMENTS_TABLE,
  USER_GROUPS_TABLE,
  DROPS_TABLE,
  DROPS_PARTS_TABLE
} from '@/constants';
import {
  ModerationEvaluation,
  ModerationFilter,
  ModerationInput,
  ModerationItem,
  ModerationOutcome,
  moderationFingerprint,
  moderationItemId,
  suppressionKey
} from './moderation-review.types';
import {
  CONTENT_MODERATION_REPORTS_TABLE,
  CONTENT_MODERATION_DROP_STATES_TABLE,
  PROFILES_TABLE,
  PROFILE_GROUPS_TABLE
} from '@/constants';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { ContentModerationReportEntity } from '@/entities/IContentModeration';

export function moderationConflict(): never {
  throw new CustomApiCompliantException(
    409,
    'Content or review state changed. Refresh before acting.',
    'MODERATION_REVISION_CONFLICT'
  );
}
export function assertModerationPermitReplay(
  item: ModerationItem,
  requestId: string | undefined
): void {
  if (item.scope.save_request_id !== requestId)
    throw new CustomApiCompliantException(
      409,
      'This approval has already been used. Only a retry with the original request key can return the saved result.',
      'MODERATION_PERMIT_CONSUMED'
    );
}
function jsonValue<T>(value: T | string | null): T | null {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}
function itemRow(row: ModerationItem): ModerationItem {
  return {
    ...row,
    scope: jsonValue<Record<string, unknown>>(row.scope) ?? {},
    evidence: jsonValue<Record<string, unknown>>(row.evidence),
    suppressed: row.suppressed === true || Number(row.suppressed) === 1,
    version: Number(row.version),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    evidence_expires_at:
      row.evidence_expires_at === null ? null : Number(row.evidence_expires_at),
    permit_expires_at:
      row.permit_expires_at === null ? null : Number(row.permit_expires_at),
    permit_consumed_at:
      row.permit_consumed_at === null ? null : Number(row.permit_consumed_at)
  };
}

export class ModerationReviewDb extends LazyDbAccessCompatibleService {
  async lockProfile(id: string, ctx: RequestContext) {
    return this.timed('lockProfile', ctx, async () => {
      await this.db.execute(
        `select external_id from ${PROFILES_TABLE} where external_id=:id for update`,
        { id },
        this.options(ctx)
      );
    });
  }
  async lockDrop(id: string, ctx: RequestContext) {
    return this.timed('lockDrop', ctx, async () => {
      await this.db.execute(
        `select id from ${DROPS_TABLE} where id=:id for update`,
        { id },
        this.options(ctx)
      );
    });
  }
  async lockSubject(item: ModerationItem, ctx: RequestContext) {
    return this.timed('lockSubject', ctx, async () => {
      if (item.author_profile_id)
        await this.lockProfile(item.author_profile_id, ctx);
      if (item.subject_type === 'GROUP_NAME')
        await this.lockGroup(item.published_subject_id ?? item.subject_id, ctx);
      if (
        item.subject_type === 'DROP' &&
        (item.published_subject_id || item.operation === 'UPDATE')
      )
        await this.lockDrop(item.published_subject_id ?? item.subject_id, ctx);
    });
  }
  async invalidateRelatedVersions(
    item: ModerationItem,
    action: string,
    ctx: RequestContext
  ) {
    return this.timed('invalidateRelatedVersions', ctx, async () => {
      if (['SUSPEND', 'REINSTATE'].includes(action)) {
        await this.db.execute(
          `update ${ITEMS} set version=version+1 where author_profile_id=:author and id<>:id`,
          { author: item.author_profile_id, id: item.id },
          this.options(ctx)
        );
      } else if (item.published_subject_id) {
        await this.db.execute(
          `update ${ITEMS} set version=version+1 where published_subject_id=:subject and id<>:id`,
          { subject: item.published_subject_id, id: item.id },
          this.options(ctx)
        );
      }
    });
  }
  async bumpVersion(id: string, ctx: RequestContext) {
    return this.timed('bumpVersion', ctx, async () => {
      await this.db.execute(
        `update ${ITEMS} set version=version+1 where id=:id`,
        { id },
        this.options(ctx)
      );
    });
  }
  async lockGroup(id: string, ctx: RequestContext) {
    return this.timed('lockGroup', ctx, async () => {
      await this.db.execute(
        `select id from ${USER_GROUPS_TABLE} where id=:id for update`,
        { id },
        this.options(ctx)
      );
    });
  }
  async groupDefinition(
    id: string,
    ctx: RequestContext = {}
  ): Promise<Record<string, unknown> | null> {
    return this.timed('groupDefinition', ctx, async () => {
      const group = await this.db.oneOrNull<UserGroupEntity>(
        `select * from ${USER_GROUPS_TABLE} where id=:id`,
        { id },
        this.options(ctx)
      );
      if (!group) return null;
      const groupIds = [
        group.profile_group_id,
        group.excluded_profile_group_id
      ].filter((value): value is string => !!value);
      const members = groupIds.length
        ? await this.db.execute<{
            profile_group_id: string;
            profile_id: string;
          }>(
            `select profile_group_id,profile_id from ${PROFILE_GROUPS_TABLE} where profile_group_id in (:groupIds) order by profile_id`,
            { groupIds },
            this.options(ctx)
          )
        : [];
      const definition = Object.fromEntries(
        Object.entries(group).filter(
          ([key]) =>
            ![
              'id',
              'created_at',
              'profile_group_id',
              'excluded_profile_group_id',
              'is_pure_profile_group',
              'visible'
            ].includes(key)
        )
      );
      return {
        ...definition,
        included_profiles: members
          .filter((row) => row.profile_group_id === group.profile_group_id)
          .map((row) => row.profile_id),
        excluded_profiles: members
          .filter(
            (row) => row.profile_group_id === group.excluded_profile_group_id
          )
          .map((row) => row.profile_id)
      };
    });
  }
  private routineSelect() {
    return `select concat('routine:',id) id, 'DROP' subject_type, drop_id subject_id, author_profile_id, author_profile_id actor_profile_id, operation,
      'WAVE_CONTENT' policy_family, coalesce(evaluator_version,deterministic_gate_version) policy_version, content_fingerprint,
      json_object() scope, null evidence, outcome, coalesce(deterministic_signal,'NO_SIGNAL') \`trigger\`, 'REVIEWED' review_status,
      null override, null permit_expires_at, null permit_consumed_at, null published_subject_id, false suppressed, 1 version,
      created_at, created_at updated_at, created_at+2592000000 evidence_expires_at from ${CHECKS} where item_id is null`;
  }
  private itemSelect() {
    return `select id,subject_type,subject_id,author_profile_id,actor_profile_id,operation,policy_family,policy_version,content_fingerprint,scope,evidence,outcome,\`trigger\`,review_status,override,permit_expires_at,permit_consumed_at,published_subject_id,suppressed,version,created_at,updated_at,evidence_expires_at from ${ITEMS}`;
  }
  async reportForReview(id: string, ctx: RequestContext = {}, lock = false) {
    return this.timed('reportForReview', ctx, async () => {
      const report = await this.db.oneOrNull<ContentModerationReportEntity>(
        `select * from ${CONTENT_MODERATION_REPORTS_TABLE} where id=:id${lock ? ' for update' : ''}`,
        { id },
        this.options(ctx)
      );
      if (!report) throw new NotFoundException('Report not found');
      return {
        ...report,
        content_snapshot:
          jsonValue<Record<string, unknown>>(report.content_snapshot) ?? {},
        ai_evidence: jsonValue<unknown[]>(report.ai_evidence)
      };
    });
  }
  async attachPublication(
    id: string,
    publishedId: string,
    revision: string,
    ctx: RequestContext = {}
  ) {
    return this.timed('attachPublication', ctx, async () => {
      await this.db.execute(
        `update ${ITEMS} set published_subject_id=:publishedId,scope=json_set(scope,'$.published_revision',:revision) where id=:id`,
        { id, publishedId, revision },
        this.options(ctx)
      );
    });
  }
  async bindReport(reportId: string, itemId: string, ctx: RequestContext = {}) {
    return this.timed('bindReport', ctx, async () => {
      await this.db.execute(
        `update ${CONTENT_MODERATION_REPORTS_TABLE} set item_id=:itemId where id=:reportId`,
        { reportId, itemId },
        this.options(ctx)
      );
    });
  }
  async refreshReportResolution(id: string, ctx: RequestContext) {
    return this.timed('refreshReportResolution', ctx, async () => {
      await this.db.execute(
        `update ${ITEMS} i set
        i.review_status=if(exists(select 1 from ${CONTENT_MODERATION_REPORTS_TABLE} r where r.item_id=i.id and r.status='OPEN'),i.review_status,'REVIEWED'),
        i.evidence_expires_at=if(exists(select 1 from ${CONTENT_MODERATION_REPORTS_TABLE} r where r.item_id=i.id and r.status='OPEN'),null,
          (select coalesce(max(r.resolved_at),:now)+:retention from ${CONTENT_MODERATION_REPORTS_TABLE} r where r.item_id=i.id))
        where i.id=:id`,
        { id, now: Date.now(), retention: 90 * 86400000 },
        this.options(ctx)
      );
    });
  }
  private options(ctx: RequestContext) {
    return { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE };
  }
  private async timed<T>(
    name: string,
    ctx: RequestContext,
    run: () => Promise<T>
  ): Promise<T> {
    const key = `${this.constructor.name}->${name}`;
    ctx.timer?.start(key);
    try {
      return await run();
    } finally {
      ctx.timer?.stop(key);
    }
  }
  async start(
    input: ModerationInput,
    trigger: string,
    ctx: RequestContext = {},
    retryOf: string | null = null
  ): Promise<{ item: ModerationItem; evaluationId: string }> {
    if (!ctx.connection)
      return this.executeNativeQueriesInTransaction((connection) =>
        this.start(input, trigger, { ...ctx, connection }, retryOf)
      ).catch(() => {
        throw new CustomApiCompliantException(
          503,
          'Moderation history is temporarily unavailable. Please retry.',
          'MODERATION_CAPTURE_UNAVAILABLE'
        );
      });
    return this.timed('start', ctx, async () => {
      const id = moderationItemId(input);
      const now = Date.now();
      await this.db.execute(
        `insert into ${ITEMS}
        (id, subject_type, subject_id, author_profile_id, actor_profile_id, operation, policy_family, policy_version, scope, evidence, content_fingerprint, outcome, \`trigger\`, review_status, version, created_at, updated_at)
        values (:id, :subject_type, :subject_id, :author_profile_id, :actor_profile_id, :operation, :policy_family, :policy_version, cast(:scope as json), cast(:evidence as json), :fingerprint, 'PENDING', :trigger, 'NEEDS_REVIEW', 1, :now, :now)
        on duplicate key update evidence=coalesce(evidence,values(evidence)),evidence_expires_at=if(evidence_expires_at<:now,null,evidence_expires_at)`,
        {
          ...input,
          id,
          scope: JSON.stringify(input.scope),
          evidence: JSON.stringify(input.evidence),
          fingerprint: moderationFingerprint(input.evidence),
          trigger,
          now
        },
        this.options(ctx)
      );
      const evaluationId = randomUUID();
      await this.db.execute(
        `insert into ${EVALUATIONS} (id, item_id, retry_of, \`trigger\`, outcome, policy_version, cache_hit, started_at, result) values (:id, :itemId, :retryOf, :trigger, 'PENDING', :policy, false, :now, cast(:request as json))`,
        {
          id: evaluationId,
          itemId: id,
          retryOf,
          trigger,
          policy: input.policy_version,
          request: JSON.stringify({
            request: {
              actor_profile_id: input.actor_profile_id,
              scope: input.scope
            }
          }),
          now
        },
        this.options(ctx)
      );
      return { item: await this.get(id, ctx), evaluationId };
    });
  }
  async finish(
    id: string,
    result: {
      outcome: ModerationOutcome;
      result: Record<string, unknown>;
      model?: string | null;
      cacheHit?: boolean;
      fallback?: string | null;
    },
    ctx: RequestContext = {}
  ): Promise<void> {
    if (!ctx.connection)
      return this.executeNativeQueriesInTransaction((connection) =>
        this.finish(id, result, { ...ctx, connection })
      ).catch(() => {
        throw new CustomApiCompliantException(
          503,
          'Moderation history is temporarily unavailable. Please retry.',
          'MODERATION_CAPTURE_UNAVAILABLE'
        );
      });
    return this.timed('finish', ctx, async () => {
      await this.db.execute(
        `update ${EVALUATIONS} set outcome=:outcome, result=json_merge_patch(coalesce(result,json_object()),cast(:result as json)), provider=:provider, model=:model, cache_hit=:cacheHit, fallback=:fallback, completed_at=:now where id=:id and completed_at is null`,
        {
          id,
          ...result,
          result: JSON.stringify(result.result),
          provider: result.model ? 'BEDROCK' : null,
          model: result.model ?? null,
          cacheHit: result.cacheHit ?? false,
          fallback: result.fallback ?? null,
          now: Date.now()
        },
        this.options(ctx)
      );
      await this.db.execute(
        `update ${ITEMS} i join ${EVALUATIONS} e on e.item_id=i.id set i.outcome=e.outcome, i.\`trigger\`=e.\`trigger\`, i.updated_at=:now, i.policy_version=e.policy_version,
        i.review_status=if(i.override is not null or exists(select 1 from ${AUDIT} a where a.item_id=i.id and a.actor_profile_id is not null and a.action not in ('CONTENT_SAVED','REEVALUATE') and a.created_at>=e.started_at),i.review_status,if(e.outcome='ALLOW' and i.operation<>'REPORT' and e.fallback is null,'REVIEWED','NEEDS_REVIEW')),
        i.evidence_expires_at=if(e.outcome='ALLOW' and i.operation<>'REPORT' and i.override is null,:expiry,if(i.review_status='NEEDS_REVIEW',null,i.evidence_expires_at)), i.version=i.version+1
        where e.id=:id and not exists (select 1 from ${EVALUATIONS} newer where newer.item_id=i.id and (newer.started_at>e.started_at or (newer.started_at=e.started_at and newer.id>e.id)) and newer.completed_at is not null)`,
        { id, now: Date.now(), expiry: Date.now() + 30 * 86400000 },
        this.options(ctx)
      );
    });
  }
  async get(
    id: string,
    ctx: RequestContext = {},
    lock = false
  ): Promise<ModerationItem> {
    return this.timed('get', ctx, async () => {
      if (id.startsWith('routine:')) {
        if (lock)
          throw new BadRequestException(
            'Routine checks have no moderation actions'
          );
        const routine = await this.db.oneOrNull<ModerationItem>(
          `select * from (${this.routineSelect()}) checks where id=:id`,
          { id },
          this.options(ctx)
        );
        if (!routine)
          throw new NotFoundException(
            'Routine check is unavailable or expired'
          );
        return itemRow(routine);
      }
      const item = await this.db.oneOrNull<ModerationItem>(
        `select * from ${ITEMS} where id=:id${lock ? ' for update' : ''}`,
        { id },
        this.options(ctx)
      );
      if (!item) throw new NotFoundException('Moderation check not found');
      return itemRow(item);
    });
  }
  async find(
    input: ModerationInput,
    ctx: RequestContext = {}
  ): Promise<ModerationItem | null> {
    return this.timed('find', ctx, async () => {
      const row = await this.db.oneOrNull<ModerationItem>(
        `select * from ${ITEMS} where id=:id`,
        { id: moderationItemId(input) },
        this.options(ctx)
      );
      return row ? itemRow(row) : null;
    });
  }
  async history(id: string, ctx: RequestContext = {}) {
    return this.timed('history', ctx, async () => {
      const evaluations = await this.db.execute<ModerationEvaluation>(
        `select * from ${EVALUATIONS} where item_id=:id order by started_at desc,id desc limit 100`,
        { id },
        this.options(ctx)
      );
      const audit = await this.db.execute<{
        id: string;
        created_at: number;
        actor_profile_id: string | null;
        action: string;
        reason: string | null;
        previous_state: string | null;
        new_state: string | null;
        metadata: Record<string, unknown> | null;
      }>(
        `select id,created_at,actor_profile_id,action,reason,previous_state,new_state,metadata from ${AUDIT} where item_id=:id order by created_at desc,id desc limit 100`,
        { id },
        this.options(ctx)
      );
      return {
        evaluations: evaluations.map((row) => ({
          ...row,
          result: jsonValue<Record<string, unknown>>(row.result),
          cache_hit: row.cache_hit === true || Number(row.cache_hit) === 1,
          started_at: Number(row.started_at),
          completed_at:
            row.completed_at === null ? null : Number(row.completed_at)
        })),
        audit: audit.map((row) => ({
          ...row,
          id: String(row.id),
          created_at: Number(row.created_at),
          metadata: jsonValue<Record<string, unknown>>(row.metadata)
        }))
      };
    });
  }
  async list(filter: ModerationFilter, ctx: RequestContext = {}) {
    return this.timed('list', ctx, async () => {
      const clauses = [
        "coalesce(json_extract(scope,'$.administrative'),false)=false"
      ];
      const params: Record<string, unknown> = { limit: filter.limit + 1 };
      for (const key of [
        'subject_type',
        'outcome',
        'policy_family',
        'trigger',
        'review_status',
        'subject_id'
      ] as const) {
        if (filter[key]) {
          clauses.push(`\`${key}\`=:${key}`);
          params[key] = filter[key];
        }
      }
      if (filter.profile_id) {
        clauses.push('author_profile_id=:profile');
        params.profile = filter.profile_id;
      }
      if (filter.from !== undefined) {
        clauses.push('created_at>=:from');
        params.from = filter.from;
      }
      if (filter.to !== undefined) {
        clauses.push('created_at<=:to');
        params.to = filter.to;
      }
      if (filter.before) {
        const match = /^(\d+)\.((?:routine:)?[a-f0-9-]{1,64})$/.exec(
          filter.before
        );
        if (!match) throw new BadRequestException('Invalid moderation cursor');
        clauses.push(
          '(created_at<:beforeTime or (created_at=:beforeTime and id<:beforeId))'
        );
        params.beforeTime = Number(match[1]);
        params.beforeId = match[2];
      }
      const rows = await this.db.execute<ModerationItem>(
        `select * from (${this.itemSelect()} union all ${this.routineSelect()}) checks where ${clauses.join(' and ')} order by created_at desc,id desc limit :limit`,
        params,
        this.options(ctx)
      );
      const items = rows.slice(0, filter.limit).map(itemRow);
      const last = items.at(-1);
      return {
        items,
        next_cursor:
          rows.length > filter.limit && last
            ? `${last.created_at}.${last.id}`
            : null
      };
    });
  }
  async counts(ctx: RequestContext = {}) {
    return this.timed('counts', ctx, async () => {
      return await this.db.oneOrNull<{
        needs_review: number;
        quarantined: number;
        rejected_today: number;
        evaluator_failures_today: number;
      }>(
        `select
      coalesce(sum(review_status='NEEDS_REVIEW' and coalesce(json_extract(scope,'$.administrative'),false)=false),0) needs_review,
      (select count(*) from ${CONTENT_MODERATION_DROP_STATES_TABLE} where status='AI_QUARANTINED') quarantined,
      coalesce(sum(outcome='REJECT' and updated_at>=:today),0) rejected_today,
      (select count(*) from ${EVALUATIONS} where fallback is not null and started_at>=:today) evaluator_failures_today
      from ${ITEMS}`,
        { today: Math.floor(Date.now() / 86400000) * 86400000 },
        this.options(ctx)
      );
    });
  }
  async audit(
    item: ModerationItem,
    input: {
      actor: string | null;
      action: string;
      reason: string;
      actionId?: string;
      evaluationId?: string;
      metadata?: Record<string, unknown>;
    },
    ctx: RequestContext
  ) {
    return this.timed('audit', ctx, async () => {
      await this.db.execute(
        `insert into ${AUDIT} (created_at, actor_profile_id, action, target_drop_id, target_profile_id, item_id, evaluation_id, action_id, previous_state, new_state, reason, metadata)
      values (:now,:actor,:action,:drop,:profile,:item,:evaluation,:actionId,:previous,:next,:reason,cast(:metadata as json))`,
        {
          now: Date.now(),
          actor: input.actor,
          action: input.action,
          drop: item.subject_type === 'DROP' ? item.published_subject_id : null,
          profile: item.author_profile_id,
          item: item.id,
          evaluation: input.evaluationId ?? null,
          actionId: input.actionId ?? null,
          previous: item.override ?? item.outcome,
          next: input.action,
          reason: input.reason,
          metadata: JSON.stringify({
            expected_version: item.version,
            ...input.metadata
          })
        },
        this.options(ctx)
      );
    });
  }
  async priorAction(actionId: string, ctx: RequestContext) {
    return this.timed('priorAction', ctx, async () => {
      return this.db.oneOrNull<{
        item_id: string;
        actor_profile_id: string;
        action: string;
        reason: string;
      }>(
        `select item_id,actor_profile_id,action,reason from ${AUDIT} where action_id=:actionId`,
        { actionId },
        this.options(ctx)
      );
    });
  }
  async decide(item: ModerationItem, action: string, ctx: RequestContext) {
    return this.timed('decide', ctx, async () => {
      if (
        action === 'RESTORE' &&
        ['PROFILE_BIO', 'GROUP_NAME'].includes(item.subject_type) &&
        item.published_subject_id
      ) {
        await this.db.execute(
          `update ${ITEMS} set suppressed=false where subject_type=:subject and published_subject_id=:publishedId and json_unquote(json_extract(scope,'$.published_revision'))=:revision`,
          {
            subject: item.subject_type,
            publishedId: item.published_subject_id,
            revision: item.scope.published_revision
          },
          this.options(ctx)
        );
      }
      const override =
        action === 'ALLOW' || action === 'BLOCK'
          ? action
          : action === 'REVOKE_OVERRIDE'
            ? null
            : item.subject_type === 'DROP' && item.published_subject_id
              ? action === 'RESTORE'
                ? 'ALLOW'
                : ['REMOVE', 'QUARANTINE'].includes(action)
                  ? 'BLOCK'
                  : item.override
              : item.override;
      const expiry =
        action === 'ALLOW' && item.subject_type !== 'REP_CATEGORY'
          ? Date.now() + 7 * 86400000
          : item.permit_expires_at;
      await this.db.execute(
        `update ${ITEMS} set override=:override, permit_expires_at=:expiry,
      permit_consumed_at=if(:reset,null,permit_consumed_at),
      review_status='REVIEWED', suppressed=:suppressed, version=version+1, updated_at=:now, evidence_expires_at=if(exists(select 1 from ${CONTENT_MODERATION_REPORTS_TABLE} r where r.item_id=${ITEMS}.id and r.status='OPEN'),null,:evidenceExpiry) where id=:id and version=:version`,
        {
          id: item.id,
          version: item.version,
          override,
          expiry,
          reset: action === 'ALLOW' || action === 'REVOKE_OVERRIDE',
          suppressed:
            action === 'SUPPRESS'
              ? true
              : action === 'RESTORE'
                ? false
                : item.suppressed,
          now: Date.now(),
          evidenceExpiry: Date.now() + 90 * 86400000
        },
        this.options(ctx)
      );
    });
  }
  async consume(
    id: string,
    publishedId: string,
    ctx: RequestContext,
    submittedSubjectId?: string
  ): Promise<string | null> {
    return this.timed('consume', ctx, async () => {
      const item = await this.get(id, ctx, true);
      if (item.override === 'BLOCK') moderationConflict();
      if (
        item.override === 'ALLOW' &&
        item.subject_type !== 'REP_CATEGORY' &&
        (item.permit_consumed_at !== null ||
          (item.permit_expires_at !== null &&
            item.permit_expires_at > Date.now()))
      ) {
        if (
          !ctx.moderationRequestId ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
            ctx.moderationRequestId
          )
        )
          throw new BadRequestException(
            'An Idempotency-Key UUID is required for an approved resubmission'
          );
        if (item.permit_consumed_at) {
          assertModerationPermitReplay(item, ctx.moderationRequestId);
          return item.published_subject_id;
        }
        if (!item.permit_expires_at || item.permit_expires_at < Date.now())
          moderationConflict();
        await this.db.execute(
          `update ${ITEMS} set permit_consumed_at=:now,published_subject_id=:publishedId,scope=json_set(scope,'$.save_request_id',:requestId,'$.save_subject_id',:submittedSubjectId),version=version+1 where id=:id`,
          {
            id,
            now: Date.now(),
            publishedId,
            submittedSubjectId: submittedSubjectId ?? null,
            requestId: ctx.moderationRequestId
          },
          this.options(ctx)
        );
      } else {
        await this.db.execute(
          `update ${ITEMS} set published_subject_id=:publishedId where id=:id`,
          { id, publishedId },
          this.options(ctx)
        );
      }
      await this.audit(
        item,
        {
          actor:
            ctx.authenticationContext?.getLoggedInUsersProfileId() ??
            item.actor_profile_id,
          action: 'CONTENT_SAVED',
          reason: 'Matching content saved',
          metadata: { published_subject_id: publishedId }
        },
        ctx
      );
      return null;
    });
  }
  async savedRequest(
    authorId: string,
    subjectType: string,
    requestId: string | undefined,
    ctx: RequestContext = {}
  ): Promise<ModerationItem | null> {
    return this.timed('savedRequest', ctx, async () => {
      if (!requestId) return null;
      const row = await this.db.oneOrNull<ModerationItem>(
        `select * from ${ITEMS} where author_profile_id=:authorId and subject_type=:subjectType and permit_consumed_at is not null and json_unquote(json_extract(scope,'$.save_request_id'))=:requestId limit 1`,
        { authorId, subjectType, requestId },
        this.options(ctx)
      );
      return row ? itemRow(row) : null;
    });
  }
  async currentRevision(
    item: Pick<
      ModerationItem,
      'subject_type' | 'subject_id' | 'published_subject_id'
    > &
      Partial<ModerationItem>,
    ctx: RequestContext = {}
  ): Promise<string | null> {
    return this.timed('currentRevision', ctx, async () => {
      if (item.subject_type === 'PROFILE_BIO') {
        const row = await this.db.oneOrNull<{
          id: string;
          statement_value: string;
        }>(
          `select id,statement_value from ${CIC_STATEMENTS_TABLE} where profile_id=:id and statement_group='GENERAL' and statement_type='BIO' order by crated_at desc,id desc limit 1`,
          { id: item.subject_id },
          this.options(ctx)
        );
        return row
          ? moderationFingerprint({ id: row.id, text: row.statement_value })
          : null;
      }
      if (item.subject_type === 'GROUP_NAME') {
        if (!item.published_subject_id && item.scope?.group_review) {
          if (!item.scope.old_version_id) return null;
          const definition = await this.groupDefinition(
            String(item.scope.old_version_id),
            ctx
          );
          return definition ? moderationFingerprint(definition) : null;
        }
        const row = await this.db.oneOrNull<{ name: string }>(
          `select name from ${USER_GROUPS_TABLE} where id=:id`,
          { id: item.published_subject_id ?? item.subject_id },
          this.options(ctx)
        );
        return row ? moderationFingerprint({ text: row.name }) : null;
      }
      if (item.subject_type === 'DROP') {
        const row = await this.db.oneOrNull<{ title: string | null }>(
          `select title from ${DROPS_TABLE} where id=:id`,
          { id: item.published_subject_id ?? item.subject_id },
          this.options(ctx)
        );
        if (!row) return null;
        const parts = await this.db.execute<{ content: string | null }>(
          `select content from ${DROPS_PARTS_TABLE} where drop_id=:id order by drop_part_id`,
          { id: item.published_subject_id ?? item.subject_id },
          this.options(ctx)
        );
        return moderationFingerprint({ title: row.title, parts });
      }
      return item.content_fingerprint ?? null;
    });
  }
  async setPublishedRevision(
    id: string,
    revision: string | null,
    ctx: RequestContext
  ) {
    return this.timed('setPublishedRevision', ctx, async () => {
      await this.db.execute(
        `update ${ITEMS} set scope=json_set(scope,'$.published_revision',:revision) where id=:id`,
        { id, revision },
        this.options(ctx)
      );
    });
  }
  async isSuppressed(
    subject: string,
    subjectId: string,
    revision: string,
    ctx: RequestContext = {}
  ): Promise<boolean> {
    return this.timed('isSuppressed', ctx, async () => {
      const row = await this.db.oneOrNull<{ id: string }>(
        `select id from ${ITEMS} where subject_type=:subject and (subject_id=:subjectId or published_subject_id=:subjectId) and suppressed=true and json_unquote(json_extract(scope,'$.published_revision'))=:revision limit 1`,
        { subject, subjectId, revision },
        this.options(ctx)
      );
      return !!row;
    });
  }
  async suppressedSubjects(
    subject: string,
    candidates: ReadonlyArray<{ id: string; revision: string }>,
    ctx: RequestContext = {}
  ): Promise<Set<string>> {
    return this.timed('suppressedSubjects', ctx, async () => {
      if (!candidates.length) return new Set();
      const ids = candidates.map((candidate) => candidate.id);
      const rows = await this.db.execute<{
        subject_id: string;
        published_subject_id: string | null;
        revision: string;
      }>(
        `select subject_id,published_subject_id,json_unquote(json_extract(scope,'$.published_revision')) revision from ${ITEMS} where subject_type=:subject and suppressed=true and (subject_id in (:ids) or published_subject_id in (:ids))`,
        { subject, ids },
        this.options(ctx)
      );
      return new Set(
        candidates
          .filter((candidate) =>
            rows.some(
              (row) =>
                (row.subject_id === candidate.id ||
                  row.published_subject_id === candidate.id) &&
                row.revision === candidate.revision
            )
          )
          .map((candidate) => suppressionKey(candidate.id, candidate.revision))
      );
    });
  }
  async retain(ctx: RequestContext = {}) {
    return this.timed('retain', ctx, async () => {
      await this.executeNativeQueriesInTransaction(async (connection) => {
        const tx = { ...ctx, connection };
        const routine = await this.db.execute<{ id: string }>(
          `select i.id from ${ITEMS} i where i.operation<>'REPORT' and i.operation<>'PROFILE_STATUS' and i.outcome='ALLOW' and i.review_status='REVIEWED' and i.override is null and i.suppressed=false and i.updated_at<:old
        and not exists(select 1 from ${EVALUATIONS} e where e.item_id=i.id and (e.outcome<>'ALLOW' or e.fallback is not null or e.completed_at is null))
        and not exists(select 1 from ${AUDIT} a where a.item_id=i.id and a.action<>'CONTENT_SAVED') limit 1000 for update`,
          { old: Date.now() - 30 * 86400000 },
          this.options(tx)
        );
        if (!routine.length) return;
        const ids = routine.map((row) => row.id);
        await this.db.execute(
          `delete from ${EVALUATIONS} where item_id in (:ids)`,
          { ids },
          this.options(tx)
        );
        await this.db.execute(
          `delete from ${AUDIT} where item_id in (:ids)`,
          { ids },
          this.options(tx)
        );
        await this.db.execute(
          `delete from ${ITEMS} where id in (:ids)`,
          { ids },
          this.options(tx)
        );
      });
      await this.db.execute(
        `update ${ITEMS} i join ${EVALUATIONS} e on e.item_id=i.id set i.outcome='ERROR',i.review_status='NEEDS_REVIEW',i.version=i.version+1,i.evidence_expires_at=null where e.completed_at is null and e.started_at<:stale and i.override is null`,
        { stale: Date.now() - 10 * 60000 },
        this.options(ctx)
      );
      await this.db.execute(
        `update ${EVALUATIONS} set outcome='ERROR',fallback='INTERRUPTED',completed_at=:now where completed_at is null and started_at<:stale limit 1000`,
        { now: Date.now(), stale: Date.now() - 10 * 60000 },
        this.options(ctx)
      );
      await this.db.execute(
        `update ${ITEMS} i set i.review_status='REVIEWED',i.evidence_expires_at=(select coalesce(max(r.resolved_at),:now)+:retention from ${CONTENT_MODERATION_REPORTS_TABLE} r where r.item_id=i.id)
      where i.operation='REPORT' and exists(select 1 from ${CONTENT_MODERATION_REPORTS_TABLE} r where r.item_id=i.id)
        and not exists(select 1 from ${CONTENT_MODERATION_REPORTS_TABLE} r where r.item_id=i.id and r.status='OPEN')`,
        { now: Date.now(), retention: 90 * 86400000 },
        this.options(ctx)
      );
      // Active rules retain scope and provenance; only evidence/result payloads expire.
      await this.db.execute(
        `update ${ITEMS} set evidence=null where evidence_expires_at<:now and review_status='REVIEWED' and evidence is not null and not exists(select 1 from ${CONTENT_MODERATION_REPORTS_TABLE} r where r.item_id=${ITEMS}.id and r.status='OPEN') limit 1000`,
        { now: Date.now() },
        this.options(ctx)
      );
      await this.db.execute(
        `update ${EVALUATIONS} e join ${ITEMS} i on i.id=e.item_id set e.result=null where i.evidence is null and i.evidence_expires_at<:now`,
        { now: Date.now() },
        this.options(ctx)
      );
      await this.db.execute(
        `delete from ${AUDIT} where item_id is not null and created_at<:old and item_id in (select id from ${ITEMS} where override is null and suppressed=false and updated_at<:old) limit 1000`,
        { old: Date.now() - 365 * 86400000 },
        this.options(ctx)
      );
      await this.db.execute(
        `delete from ${EVALUATIONS} where started_at<:old and item_id in (select id from ${ITEMS} where review_status='REVIEWED' and override is null and suppressed=false and updated_at<:old) limit 1000`,
        { old: Date.now() - 365 * 86400000 },
        this.options(ctx)
      );
      await this.db.execute(
        `update ${CONTENT_MODERATION_REPORTS_TABLE} set content_snapshot=json_object('evidence_expired',true),notes=null,ai_rationale=null,ai_evidence=null where status<>'OPEN' and resolved_at<:old and json_extract(content_snapshot,'$.evidence_expired') is null limit 1000`,
        { old: Date.now() - 90 * 86400000 },
        this.options(ctx)
      );
    });
  }
}
export const moderationReviewDb = new ModerationReviewDb(dbSupplier);
