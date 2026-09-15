import { Logger } from '@/logging';

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER_SEND');

const CODES = {
  'messaging/mismatched-credential': 'FCM_MISMATCHED_CREDENTIAL',
  'messaging/authentication-error': 'FCM_AUTHENTICATION_ERROR',
  'messaging/server-unavailable': 'FCM_SERVER_UNAVAILABLE',
  'messaging/internal-error': 'FCM_INTERNAL_ERROR',
  'messaging/message-rate-exceeded': 'FCM_MESSAGE_RATE_EXCEEDED',
  'messaging/device-message-rate-exceeded': 'FCM_DEVICE_MESSAGE_RATE_EXCEEDED',
  'messaging/invalid-payload': 'FCM_INVALID_PAYLOAD',
  'messaging/payload-size-limit-exceeded': 'FCM_PAYLOAD_SIZE_LIMIT_EXCEEDED',
  'messaging/invalid-registration-token': 'FCM_INVALID_REGISTRATION_TOKEN',
  'messaging/registration-token-not-registered':
    'FCM_REGISTRATION_NOT_REGISTERED'
} as const;

const STAGES = ['prepare', 'sdk_batch', 'sdk_response', 'image_retry'] as const;

export type PushSendStage = (typeof STAGES)[number];
type PushSendCode = (typeof CODES)[keyof typeof CODES] | 'UNKNOWN';

export interface PushSendDiagnostic extends Error {
  readonly code: PushSendCode;
  readonly stage: PushSendStage;
}

function readCode(error: unknown): PushSendCode {
  try {
    if (typeof error !== 'object' || error === null) return 'UNKNOWN';
    const code: unknown = (error as { code?: unknown }).code;
    const key = Object.keys(CODES).find((candidate) => candidate === code);
    return key ? CODES[key as keyof typeof CODES] : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

/** One safe Error per terminal attempt; never retain the provider exception. */
export function createPushSendDiagnostic(
  error: unknown,
  stage: PushSendStage
): PushSendDiagnostic {
  const code = readCode(error);
  const safeStage =
    STAGES.find((candidate) => candidate === stage) ?? 'prepare';
  const diagnostic = Object.assign(
    new Error(`Push notification failed [${safeStage}/${code}]`),
    {
      name: `PushSend.${safeStage}.${code}`,
      code,
      stage: safeStage
    }
  );
  delete diagnostic.stack;
  return diagnostic;
}

/** The same Error at both reporting layers uses existing invocation deduplication. */
export function reportPushSendDiagnostic(diagnostic: PushSendDiagnostic): void {
  try {
    logger.error(diagnostic.message, diagnostic);
  } catch {
    // Diagnostics must not change the original delivery or retry outcome.
  }
}

export function reportPushImageRetry(): void {
  try {
    logger.info(
      'FCM_INVALID_PAYLOAD: retrying push notification without image'
    );
  } catch {
    // Keep the existing retry even when the diagnostic transport is unavailable.
  }
}
