import * as Sentry from '@sentry/serverless';
import type { Handler } from 'aws-lambda';

interface LambdaSentryOptions {
  readonly shouldCaptureException?: (error: unknown) => boolean;
}

export function isConfigured() {
  return !!process.env.SENTRY_DSN;
}

export function wrapLambdaHandler(
  handler: Handler,
  options: LambdaSentryOptions = {}
): Handler {
  if (isConfigured()) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT,
      debug: process.env.SENTRY_DEBUG === 'true',
      beforeSend: (event, hint) =>
        options.shouldCaptureException?.(hint.originalException) === false
          ? null
          : event
    });
    return Sentry.AWSLambda.wrapHandler(handler);
  }
  return handler;
}
