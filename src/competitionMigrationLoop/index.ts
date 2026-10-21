import * as sentryContext from '@/sentry.context';

/** Inert transition artifact. Pending invocations are acknowledged without DB
 * access or self-invocation. Physical Lambda/IAM/alarm removal is a later step. */
export async function handleMigration() {
  return {
    status: 'RETIRED',
    message: 'Legacy competition migration is retired'
  } as const;
}

export const handler = sentryContext.wrapLambdaHandler(handleMigration);
