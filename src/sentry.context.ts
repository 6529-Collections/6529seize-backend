import * as Sentry from '@sentry/serverless';
import { Logger } from '@/logging';
import type { Handler } from 'aws-lambda';
import { operationalError, withOperationalContext } from '@/operational-errors';

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
  operationalError('SENTRY_CONTEXT', [error]);
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
  const capture: Handler = (event, context, callback) =>
    withOperationalContext(context?.awsRequestId, () => {
      const report = (error: unknown) => {
        let shouldCapture = true;
        try {
          shouldCapture = options.shouldCaptureException?.(error) !== false;
        } catch {
          // Diagnostic filtering must never replace the original invocation failure.
        }
        if (shouldCapture) {
          operationalError(
            'LAMBDA_HANDLER',
            [error],
            context?.awsRequestId,
            'LAMBDA_FAILURE'
          );
        }
      };
      try {
        const result = handler(event, context, (error, value) => {
          if (error) report(error);
          callback?.(error, value);
        });
        if (result && typeof result.then === 'function') {
          return result.catch((error: unknown) => {
            report(error);
            throw error;
          });
        }
        return result;
      } catch (error) {
        report(error);
        throw error;
      }
    });
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
    return Sentry.AWSLambda.wrapHandler(capture);
  }
  return capture;
}
