import type {
  AccessTokenBinding,
  AccessTokenClientType,
  AccessTokenSession
} from '@/auth-context';
import type {
  WalletAuthClientType,
  WalletAuthSignatureFormat
} from '@/entities/IWalletAuthSession';

// Access-token claim names: client type, session binding, session id.
const CLIENT_TYPE_CLAIM = 'ct';
const BINDING_CLAIM = 'sb';
const SESSION_ID_CLAIM = 'sid';

const CLIENT_TYPES: readonly AccessTokenClientType[] = [
  'web',
  'native',
  'desktop',
  'legacy'
];
const BINDINGS: readonly AccessTokenBinding[] = [
  'siwe',
  'structured',
  'share',
  'legacy_text'
];
const SIGNATURE_FORMATS: readonly WalletAuthSignatureFormat[] = [
  'siwe',
  'structured',
  'share'
];
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The structured login text verifyClientSignature accepts; anything else
// /auth/login accepts is the plain-text nonce.
const STRUCTURED_LOGIN_MESSAGE_PREFIX = '6529 Authentication\n';

/** A token minted outside a session-v2 session: nothing else is known. */
export const LEGACY_ACCESS_TOKEN_SESSION: AccessTokenSession = {
  clientType: 'legacy',
  binding: null,
  sessionId: null
};

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown
): T | null {
  return typeof value === 'string' &&
    (values as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** The `ct`, `sb` and `sid` claims for a session; unknown parts are left out. */
export function toAccessTokenSessionClaims(
  session: AccessTokenSession
): Record<string, string> {
  return {
    ...(session.clientType ? { [CLIENT_TYPE_CLAIM]: session.clientType } : {}),
    ...(session.binding ? { [BINDING_CLAIM]: session.binding } : {}),
    ...(session.sessionId ? { [SESSION_ID_CLAIM]: session.sessionId } : {})
  };
}

/**
 * The session claims of a verified access-token payload. A missing or
 * unrecognised claim reads as null and never makes the token invalid, so
 * tokens minted before these claims existed keep working unchanged.
 */
export function readAccessTokenSessionClaims(
  payload: Readonly<Record<string, unknown>>
): AccessTokenSession {
  const sessionId = payload[SESSION_ID_CLAIM];
  return {
    clientType: oneOf(CLIENT_TYPES, payload[CLIENT_TYPE_CLAIM]),
    binding: oneOf(BINDINGS, payload[BINDING_CLAIM]),
    sessionId:
      typeof sessionId === 'string' && SESSION_ID.test(sessionId)
        ? sessionId
        : null
  };
}

/** Whether the token said anything about its session. */
export function hasAccessTokenSessionClaims(
  session: AccessTokenSession
): boolean {
  return (
    session.clientType !== null ||
    session.binding !== null ||
    session.sessionId !== null
  );
}

/** The stored signature format of a session row, or null when unknown. */
export function toWalletAuthSignatureFormat(
  value: unknown
): WalletAuthSignatureFormat | null {
  return oneOf(SIGNATURE_FORMATS, value);
}

/** The session claims of a token minted for a session-v2 session row. */
export function accessTokenSessionOf(session: {
  readonly id: string;
  readonly client_type: WalletAuthClientType;
  readonly signature_format?: string | null;
}): AccessTokenSession {
  return {
    clientType: oneOf(CLIENT_TYPES, session.client_type),
    binding: toWalletAuthSignatureFormat(session.signature_format),
    sessionId: session.id
  };
}

/** The session claims of a token minted by `/auth/login`. */
export function legacyLoginAccessTokenSession(
  signedMessage: string
): AccessTokenSession {
  return {
    ...LEGACY_ACCESS_TOKEN_SESSION,
    binding: signedMessage.startsWith(STRUCTURED_LOGIN_MESSAGE_PREFIX)
      ? 'structured'
      : 'legacy_text'
  };
}
