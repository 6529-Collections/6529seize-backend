import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';
import { ABUSIVENESS_DETECTION_RESULTS_TABLE } from '../constants';
import { AbusivenessDetectionResult } from '../entities/IAbusivenessDetectionResult';

export class AbusivenessCheckDb extends LazyDbAccessCompatibleService {
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
