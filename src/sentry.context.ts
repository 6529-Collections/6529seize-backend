import * as Sentry from '@sentry/serverless';
import { Logger } from '@/logging';
import type { Handler } from 'aws-lambda';

const logger = Logger.get('SENTRY_CONTEXT');

export type LambdaSentryEvent = Parameters<typeof Sentry.captureEvent>[0];

interface LambdaSentryOptions {
  readonly shouldCaptureException?: (error: unknown) => boolean;
  readonly enrichEvent?: (
    event: LambdaSentryEvent,
    error: unknown
  ) => LambdaSentryEvent;
}

export function isConfigured() {
  return !!process.env.SENTRY_DSN;
}

export function captureException(error: unknown): void {
  if (!isConfigured()) {
    return;
  }
  try {
    Sentry.captureException(error);
  } catch (captureError) {
    logger.error('Failed to capture exception in Sentry', captureError);
  }
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
          : (options.enrichEvent?.(event, hint.originalException) ?? event)
    });
    return Sentry.AWSLambda.wrapHandler(handler);
  }
  return handler;
}
