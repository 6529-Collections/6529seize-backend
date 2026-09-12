import { CicStatement, CicStatementGroup } from '@/entities/ICICStatement';
import { RequestContext } from '@/request.context';
import { moderationReviewDb, ModerationReviewDb } from './moderation-review.db';
import {
  moderationFingerprint,
  suppressionKey
} from './moderation-review.types';

type BioSource = { id: string; profile_id: string; bio: string };
type GroupSource = { id: string; name: string };

export class ModerationPresentationService {
  constructor(
    private readonly reviewDb: Pick<ModerationReviewDb, 'suppressedSubjects'>
  ) {}

  async profileBios<T extends BioSource>(
    bios: T[],
    ctx: RequestContext
  ): Promise<T[]> {
    const suppressed = await this.reviewDb.suppressedSubjects(
      'PROFILE_BIO',
      bios.map((bio) => ({
        id: bio.profile_id,
        revision: moderationFingerprint({ id: bio.id, text: bio.bio })
      })),
      ctx
    );
    return bios.filter(
      (bio) =>
        !suppressed.has(
          suppressionKey(
            bio.profile_id,
            moderationFingerprint({ id: bio.id, text: bio.bio })
          )
        )
    );
  }

  async cicStatements(
    statements: CicStatement[],
    ctx: RequestContext
  ): Promise<CicStatement[]> {
    const bios = statements.filter(
      (statement) =>
        statement.statement_group === CicStatementGroup.GENERAL &&
        statement.statement_type === 'BIO'
    );
    const suppressed = await this.reviewDb.suppressedSubjects(
      'PROFILE_BIO',
      bios.map((statement) => ({
        id: statement.profile_id,
        revision: moderationFingerprint({
          id: statement.id,
          text: statement.statement_value
        })
      })),
      ctx
    );
    const bioIds = new Set(bios.map((statement) => statement.id));
    return statements.map((statement) =>
      bioIds.has(statement.id) &&
      suppressed.has(
        suppressionKey(
          statement.profile_id,
          moderationFingerprint({
            id: statement.id,
            text: statement.statement_value
          })
        )
      )
        ? { ...statement, statement_value: '', statement_comment: null }
        : statement
    );
  }

  async groupNames(
    groups: GroupSource[],
    ctx: RequestContext
  ): Promise<Record<string, string>> {
    const suppressed = await this.reviewDb.suppressedSubjects(
      'GROUP_NAME',
      groups.map((group) => ({
        id: group.id,
        revision: moderationFingerprint({ text: group.name })
      })),
      ctx
    );
    return Object.fromEntries(
      groups.map((group) => [
        group.id,
        suppressed.has(
          suppressionKey(group.id, moderationFingerprint({ text: group.name }))
        )
          ? 'Name hidden by moderation'
          : group.name
      ])
    );
  }
}

export const moderationPresentationService = new ModerationPresentationService(
  moderationReviewDb
);
