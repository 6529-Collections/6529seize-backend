import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';
import {
  ABUSIVENESS_DETECTION_RESULTS_TABLE,
  CONTENT_MODERATION_ITEMS_TABLE
} from '@/constants';
import { AbusivenessDetectionResult } from '../entities/IAbusivenessDetectionResult';
import { RequestContext } from '../request.context';

export class AbusivenessCheckDb extends LazyDbAccessCompatibleService {
  async saveVersionedResult(result: AbusivenessDetectionResult) {
    await this.db.execute(
      `insert into ${ABUSIVENESS_DETECTION_RESULTS_TABLE} (text,status,explanation,external_check_performed_at,policy_version,model)
      values (:text,:status,:explanation,:external_check_performed_at,:policy_version,:model)
      on duplicate key update status=values(status),explanation=values(explanation),external_check_performed_at=values(external_check_performed_at),policy_version=values(policy_version),model=values(model)`,
      result
    );
  }
  async searchAllowedTextsLike({
    text,
    limit
  }: {
    text: string;
    limit: number;
  }): Promise<string[]> {
    if (limit < 1) {
      return [];
    }
    return await this.db
      .execute(
        `select text from (
          select a.text from ${ABUSIVENESS_DETECTION_RESULTS_TABLE} a where a.status='ALLOWED'
            and not exists (select 1 from ${CONTENT_MODERATION_ITEMS_TABLE} i where i.subject_type='REP_CATEGORY' and i.subject_id=a.text and i.override='BLOCK')
          union select subject_id text from ${CONTENT_MODERATION_ITEMS_TABLE} where subject_type='REP_CATEGORY' and override='ALLOW'
        ) allowed_categories where lower(text) like concat('%', :text, '%') order by CHAR_LENGTH(text) limit :limit`,
        { text: text.toLowerCase(), limit }
      )
      .then((results) =>
        results.map((result: { text: string }) => result.text)
      );
  }

  async findResult(text: string): Promise<AbusivenessDetectionResult | null> {
    return await this.db
      .execute(
        `select * from ${ABUSIVENESS_DETECTION_RESULTS_TABLE} where text = :text`,
        { text }
      )
      .then((results) => {
        if (results.length > 0) {
          return {
            ...results[0],
            external_check_performed_at: new Date(
              results[0].external_check_performed_at
            )
          };
        }
        return null;
      });
  }

  async findResults(
    phrases: string[],
    ctx: RequestContext
  ): Promise<AbusivenessDetectionResult[]> {
    if (!phrases.length) {
      return [];
    }
    ctx.timer?.start(`${this.constructor.name}->findResults`);
    const result = await this.db
      .execute<AbusivenessDetectionResult>(
        `select * from ${ABUSIVENESS_DETECTION_RESULTS_TABLE} where text in (:phrases)`,
        { phrases }
      )
      .then((results) =>
        results.map((result) => ({
          ...result,
          external_check_performed_at: new Date(
            result.external_check_performed_at
          )
        }))
      );
    ctx.timer?.stop(`${this.constructor.name}->findResults`);
    return result;
  }

  async saveResult(result: AbusivenessDetectionResult) {
    try {
      await this.db.execute(
        `insert into ${ABUSIVENESS_DETECTION_RESULTS_TABLE} (text, status, explanation, external_check_performed_at)
         values (:text, :status, :explanation, :external_check_performed_at)`,
        result
      );
    } catch (e) {
      const dbError = e as { code?: string };
      if (dbError.code === 'ER_DUP_ENTRY') {
        const existingResult = await this.findResult(result.text);
        if (existingResult) {
          return existingResult;
        }
      }
      // If it's not a duplicate entry error or we couldn't find the existing result, rethrow:
      throw e;
    }
  }
}

export const abusivenessCheckDb = new AbusivenessCheckDb(dbSupplier);
