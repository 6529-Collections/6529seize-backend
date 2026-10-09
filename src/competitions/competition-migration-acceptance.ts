import * as Joi from 'joi';
import { MigrationAcceptance } from './competition-migration-policy';

const evidence = Joi.string()
  .uri({ scheme: ['https'] })
  .max(2000)
  .required();
export const MigrationAcceptanceSchema = Joi.object<MigrationAcceptance>({
  nativeRankCompletion: evidence,
  nativeApproveCompletion: evidence,
  operationalAcceptance: evidence,
  compatibilityAcceptance: evidence,
  rollbackRehearsal: evidence,
  alertsVerified: evidence,
  productionEvidenceVerifiedBy: Joi.string().min(1).max(100).required(),
  productionEvidenceVerifiedAt: Joi.number().integer().min(1).required(),
  comparisonWindowMs: Joi.number()
    .integer()
    .min(60000)
    .max(86400000)
    .required(),
  serviceRevisions: Joi.object()
    .pattern(
      Joi.string().valid(
        'api',
        'waveDecisionExecutionLoop',
        'waveLeaderboardSnapshotterLoop',
        'tdhLoop'
      ),
      Joi.string().pattern(/^[a-f0-9]{40}$/)
    )
    .min(4)
    .required(),
  apiBaselineP95: Joi.number().positive().required(),
  apiP95: Joi.number().positive().required(),
  apiBudgetP95: Joi.number().positive().required(),
  apiBaselineErrorRate: Joi.number().min(0).max(1).required(),
  apiErrorRate: Joi.number().min(0).max(1).required(),
  decisionBudgetP95: Joi.number().positive().required(),
  decisionBudgetP99: Joi.number().positive().required(),
  decisionP95: Joi.number().min(0).required(),
  decisionP99: Joi.number().min(0).required(),
  incidentWindowStartsAt: Joi.number().integer().min(1).required(),
  incidentWindowEndsAt: Joi.number().integer().min(1).required()
}).unknown(false);
