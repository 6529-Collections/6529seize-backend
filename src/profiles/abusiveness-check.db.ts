import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';
import { ABUSIVENESS_DETECTION_RESULTS_TABLE } from '../constants';
import { AbusivenessDetectionResult } from '../entities/IAbusivenessDetectionResult';

export class AbusivenessCheckDb extends LazyDbAccessCompatibleService {
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
        `select text from ${ABUSIVENESS_DETECTION_RESULTS_TABLE} where text like concat('%', :text, '%') and status = 'ALLOWED' order by CHAR_LENGTH(text) limit :limit`,
        { text, limit }
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

  async saveResult(result: AbusivenessDetectionResult) {
    await this.db.execute(
      `insert into ${ABUSIVENESS_DETECTION_RESULTS_TABLE} (text, status, explanation, external_check_performed_at)
       values (:text, :status, :explanation, :external_check_performed_at)`,
      result
    );
  }
}

export const abusivenessCheckDb = new AbusivenessCheckDb(dbSupplier);
