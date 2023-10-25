import * as Sentry from '@sentry/serverless';
import type { Handler } from 'aws-lambda';

export function isConfigured() {
  return !!process.env.SENTRY_DSN;
}

export function wrapLambdaHandler(handler: Handler): Handler {
  if (isConfigured()) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT,
      debug: process.env.SENTRY_DEBUG === 'true'
    });
    return Sentry.AWSLambda.wrapHandler(handler);
  }
  return handler;
}
