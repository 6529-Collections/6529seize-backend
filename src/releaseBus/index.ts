import type { Handler } from 'aws-lambda';
import * as sentryContext from '@/sentry.context';
import { doInDbContext } from '@/secrets';
import { Logger } from '@/logging';
import * as releaseEntities from '@/entities/entities';
import { releaseBusGitHubApp } from '@/releaseBusV2/release-bus-v2.github-app';
import {
  releaseBusV2Branch,
  releaseBusV2Reconciler
} from '@/releaseBusV2/release-bus-v2.reconciler';
import { releaseBusV2Repository } from '@/releaseBusV2/release-bus-v2.repository';

const logger = Logger.get('RELEASE_BUS_V2');
const entities = Object.values(releaseEntities).filter(
  (value) => typeof value === 'function'
);
const TERMINAL_TRAIN_STATUSES = new Set([
  'STAGING_VALIDATED',
  'PRODUCTION_DEPLOYED',
  'FAILED',
  'CANCELLED'
]);

function branchRetentionMs(): number {
  const retentionDays = Number(
    process.env.RELEASE_BUS_V2_BRANCH_RETENTION_DAYS ?? '7'
  );
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 365
  )
    throw new Error('Invalid Release Bus v2 branch retention');
  return retentionDays * 24 * 60 * 60 * 1000;
}

const cleaner: Handler = async () =>
  doInDbContext(
    async () => {
      const retentionMs = branchRetentionMs();
      const trains = await releaseBusV2Repository.listTrains(500, {});
      const deleted: string[] = [];
      for (const repository of ['frontend', 'backend'] as const) {
        const protectedRefs = new Set(
          trains
            .filter((train) => !TERMINAL_TRAIN_STATUSES.has(train.status))
            .map((train) => releaseBusV2Branch(train, repository))
        );
        const refs = await releaseBusGitHubApp.listReleaseBusV2Refs(repository);
        for (const ref of refs) {
          if (protectedRefs.has(ref.ref)) continue;
          const committedAt = await releaseBusGitHubApp.commitTimestamp(
            repository,
            ref.sha
          );
          if (Date.now() - committedAt < retentionMs) continue;
          await releaseBusGitHubApp.deleteReleaseBusV2Ref(repository, ref.ref);
          deleted.push(`${repository}:${ref.ref}`);
        }
      }
      return { deleted };
    },
    { logger, entities, skipRedis: true }
  );

const reconciler: Handler = async (_event, context) =>
  doInDbContext(() => releaseBusV2Reconciler.runOnce(context.awsRequestId), {
    logger,
    entities,
    skipRedis: true
  });

export const cleanerHandler = sentryContext.wrapLambdaHandler(cleaner);
export const v2ReconcilerHandler = sentryContext.wrapLambdaHandler(reconciler);
