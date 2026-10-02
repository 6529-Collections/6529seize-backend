import { WalletAuthSessionEntity } from '@/entities/IWalletAuthSession';
import { authDb } from './auth.db';
import { hashSecret, refreshNativeSession } from './auth-session-v2';

jest.mock('./auth.db', () => ({
  authDb: {
    getActiveNativeSessionByRefreshHash: jest.fn(),
    rotateNativeSessionRefreshToken: jest.fn()
  }
}));

const db = jest.mocked(authDb);
const request = {
  address: '0xabc',
  nativeRefreshToken: 'a'.repeat(128),
  refreshRequestId: 'c2301a36-a25d-42a1-8117-3ab72e670cc6'
};
let session: WalletAuthSessionEntity;

beforeEach(() => {
  jest
    .useFakeTimers({
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval'
      ]
    })
    .setSystemTime(new Date('2026-10-01T12:00:00Z'));
  process.env.JWT_SECRET = 'test-secret';
  process.env.JWT_EXPIRY_SECONDS = '900';
  process.env.AUTH_SESSION_HASH_SECRET = 'test-hash-secret';
  session = {
    id: 'session',
    address: request.address,
    role: null,
    client_type: 'native',
    secret_hash: null,
    refresh_token_hash: hashSecret(request.nativeRefreshToken),
    user_agent_hash: null,
    signature_domain: null,
    client_origin: null,
    created_at: new Date(),
    last_used_at: new Date(),
    expires_at: new Date(Date.now() + 86400000),
    revoked_at: null
  };
  db.getActiveNativeSessionByRefreshHash.mockImplementation(
    async (address, hash, now, client) =>
      session.address === address &&
      session.client_type === client &&
      session.refresh_token_hash === hash &&
      !session.revoked_at &&
      session.expires_at > now
        ? { ...session }
        : null
  );
  db.rotateNativeSessionRefreshToken.mockImplementation(async (params) => {
    if (session.refresh_token_hash !== params.previousRefreshTokenHash)
      return null;
    session = {
      ...session,
      refresh_token_hash: params.nextRefreshTokenHash,
      last_used_at: params.now,
      expires_at: params.expiresAt
    };
    return { ...session };
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.resetAllMocks();
  delete process.env.JWT_SECRET;
  delete process.env.JWT_EXPIRY_SECONDS;
  delete process.env.AUTH_SESSION_HASH_SECRET;
});

it('recovers a lost response on the next day without rotating or extending expiry again', async () => {
  const first = await refreshNativeSession(request);
  const expiresAt = session.expires_at;
  jest.setSystemTime(Date.now() + 86400000);
  const recovered = await refreshNativeSession(request);
  expect(recovered?.response.native_refresh_token).toBe(
    first?.response.native_refresh_token
  );
  expect(recovered?.response.refresh_token_expires_at).toEqual(expiresAt);
  expect(db.rotateNativeSessionRefreshToken).toHaveBeenCalledTimes(1);
  expect(
    await refreshNativeSession({ ...request, refreshRequestId: 'another-id' })
  ).toBeNull();
});

it('coalesces concurrent rotation and rejects replay once its successor was used', async () => {
  const results = await Promise.all([
    refreshNativeSession(request),
    refreshNativeSession(request)
  ]);
  const token = results[0]!.response.native_refresh_token;
  expect(results[1]?.response.native_refresh_token).toBe(token);
  await refreshNativeSession({
    ...request,
    nativeRefreshToken: token,
    refreshRequestId: 'next-request'
  });
  expect(await refreshNativeSession(request)).toBeNull();
});

it.each(['revoked', 'expired', 'other-address', 'other-client'])(
  'never recovers a %s session',
  async (scenario) => {
    await refreshNativeSession(request);
    if (scenario === 'revoked')
      session = { ...session, revoked_at: new Date() };
    if (scenario === 'expired')
      session = { ...session, expires_at: new Date() };
    if (scenario === 'other-address')
      session = { ...session, address: '0xdef' };
    if (scenario === 'other-client')
      session = { ...session, client_type: 'desktop' };
    expect(await refreshNativeSession(request)).toBeNull();
  }
);

it('limits legacy recovery to the existing short race window', async () => {
  const legacy = {
    address: request.address,
    nativeRefreshToken: request.nativeRefreshToken
  };
  const first = await refreshNativeSession(legacy);
  expect(
    (await refreshNativeSession(legacy))?.response.native_refresh_token
  ).toBe(first?.response.native_refresh_token);
  jest.setSystemTime(Date.now() + 30000);
  expect(await refreshNativeSession(legacy)).not.toBeNull();
  jest.setSystemTime(Date.now() + 1);
  expect(await refreshNativeSession(legacy)).toBeNull();
});

it('rejects a successor replaced between the atomic update and its readback', async () => {
  db.rotateNativeSessionRefreshToken.mockImplementationOnce(async (params) => {
    // The CAS writes our successor, then another refresh rotates it before
    // auth.db's getWalletAuthSessionByIdOrThrow readback completes.
    session = { ...session, refresh_token_hash: params.nextRefreshTokenHash };
    session = { ...session, refresh_token_hash: hashSecret('c'.repeat(128)) };
    return { ...session };
  });
  expect(await refreshNativeSession(request)).toBeNull();
  expect(db.rotateNativeSessionRefreshToken).toHaveBeenCalledTimes(1);
  expect(db.getActiveNativeSessionByRefreshHash).toHaveBeenCalledTimes(1);
});

it('allows recovery until the rotated session expiry but never at or beyond it', async () => {
  await refreshNativeSession(request);
  const expiresAt = session.expires_at.getTime();
  jest.setSystemTime(expiresAt - 1);
  expect(await refreshNativeSession(request)).not.toBeNull();
  jest.setSystemTime(expiresAt);
  expect(await refreshNativeSession(request)).toBeNull();
});
