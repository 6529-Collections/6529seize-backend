import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { sqlExecutor } from '@/sql-executor';
import {
  membershipFixtureAction,
  handleMembershipFixtureAction
} from '@/membership/membership-runtime-fixture-carrier';
import {
  assertMembershipDiagnosticInvocation,
  runMembershipRepositoryDiagnostics
} from '@/membership/membership-repository-diagnostics';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');
// Shared secret loading overwrites process.env. Keep deployment-owned identity
// from the cold-start environment, before doInDbContext loads those secrets.
const diagnosticDeployment = Object.freeze({
  stage: process.env.MEMBERSHIP_DIAGNOSTIC_STAGE,
  region: process.env.AWS_REGION
});

export const handler = sentryContext.wrapLambdaHandler(
  async (event: unknown, context) => {
    const fixtureAction = membershipFixtureAction(event);
    if (fixtureAction)
      return handleMembershipFixtureAction(fixtureAction, context, {
        stage: diagnosticDeployment.stage ?? '',
        region: diagnosticDeployment.region ?? ''
      });
    if (
      event == null ||
      (typeof event === 'object' &&
        !Array.isArray(event) &&
        Object.keys(event).length === 0)
    ) {
      logger.info('[CUSTOM REPLAY NOT IMPLEMENTED]');
      return;
    }
    assertMembershipDiagnosticInvocation(event, diagnosticDeployment);
    const result = await doInDbContext(
      () => runMembershipRepositoryDiagnostics(sqlExecutor),
      { logger, syncEntities: false, skipRedis: true }
    );
    return {
      ...result,
      deployment_stage: diagnosticDeployment.stage,
      carrier_normal_membership_work: 'absent'
    };
  }
);
