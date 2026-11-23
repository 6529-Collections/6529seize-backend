import { verifyMessage } from 'ethers';
import {
  AppDeviceGrant,
  findAppDeviceGrantRegistrationProblem,
  verifyAppDeviceGrant
} from '@/api/device-signing/app-device-grant';
import { registerDeviceGrantSchema } from '@/api/device-signing/device-signing.validation';
import { evaluateGrantOrigin } from '@/api/device-signing/grant-origins';
import type { FetchLike, ServiceGrant } from './service-setup';

/**
 * A stand-in for the 6529.io API in the setup tests. It keeps grants and the
 * profile, and checks what the setup sends the way the server does: the
 * login signature, the grant body (schema, registration checks, signature)
 * and the grant's origin for the API's host.
 */

export interface FakeCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: any;
}

const SIGNABLE = 'Sign in to the test API';
const REFRESH_TOKEN = 'ab'.repeat(64);

export function fakeSetupApi(options: {
  readonly base: string;
  readonly nowMs: number;
  readonly profileId?: string | null;
  readonly grants?: readonly ServiceGrant[];
  readonly storedId?: string;
  readonly failLogout?: boolean;
  /** GET /device-grants answers 404. */
  readonly listMissing?: boolean;
}) {
  const calls: FakeCall[] = [];
  const grants: ServiceGrant[] = [...(options.grants ?? [])];
  const apiHost = new URL(options.base).host;
  let profileId = options.profileId ?? null;
  let signedIn = false;
  const reply = (status: number, body?: unknown) => ({
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body))
  });

  const registerGrant = async (body: any) => {
    const checked = registerDeviceGrantSchema.validate(body);
    if (checked.error) return reply(400, { error: checked.error.message });
    const grant = body.grant as AppDeviceGrant;
    const problem = findAppDeviceGrantRegistrationProblem(
      grant,
      Math.floor(options.nowMs / 1000)
    );
    const verification = await verifyAppDeviceGrant({
      grant,
      signature: body.wallet_signature,
      contractWalletVerifier: {
        hasCode: async () => false,
        isValidSignature: async () => false
      }
    });
    if (problem || !verification.ok) {
      return reply(400, { error: problem ?? 'signature' });
    }
    if (!evaluateGrantOrigin(grant.origin, apiHost).recognized) {
      return reply(400, { error: 'unrecognized origin' });
    }
    grants.push({
      id: verification.grantId,
      device_key: grant.device_key,
      device_label: body.device_label ?? null,
      created_at: options.nowMs,
      expires_at: grant.expires_at * 1000,
      revoked_at: null
    });
    return reply(201, { id: options.storedId ?? verification.grantId });
  };

  const route = async (method: string, path: string, body: any) => {
    if (method === 'GET' && path.startsWith('/auth/session-nonce?')) {
      return reply(200, { signable_message: SIGNABLE, server_signature: 's' });
    }
    if (path === '/auth/session-login') {
      const signer = verifyMessage(SIGNABLE, body.client_signature);
      if (signer.toLowerCase() !== body.client_address) return reply(401, {});
      signedIn = true;
      return reply(201, {
        access_token: 'access-token',
        native_refresh_token: REFRESH_TOKEN
      });
    }
    if (path === '/auth/session-logout') {
      if (options.failLogout) return reply(500, { error: 'down' });
      if (body.native_refresh_token !== REFRESH_TOKEN) return reply(400, {});
      signedIn = false;
      return reply(204);
    }
    if (method === 'GET' && path.startsWith('/identities/')) {
      return profileId ? reply(200, { id: profileId }) : reply(404, {});
    }
    if (method === 'POST' && path === '/profiles') {
      profileId = 'new-profile-id';
      return reply(201, { id: profileId });
    }
    if (method === 'GET' && path === '/device-grants') {
      if (options.listMissing) return reply(404, { error: 'not found' });
      // As the server: newest first, at most 100, no pages.
      const listed = [...grants]
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 100);
      return reply(200, listed);
    }
    if (method === 'POST' && path === '/device-grants') {
      return registerGrant(body);
    }
    const revoke = /^\/device-grants\/(0x[0-9a-f]{64})\/revoke$/.exec(path);
    if (method === 'POST' && revoke) {
      const index = grants.findIndex((grant) => grant.id === revoke[1]);
      if (index < 0) return reply(404, {});
      grants[index] = {
        ...grants[index],
        revoked_at: grants[index].revoked_at ?? options.nowMs
      };
      return reply(200, grants[index]);
    }
    return reply(500, { error: `unexpected ${method} ${path}` });
  };

  const fetchFn: FetchLike = async (url, init) => {
    if (init.redirect !== 'error' || !url.startsWith(options.base)) {
      return reply(500, { error: 'wrong API or redirects allowed' });
    }
    const path = url.slice(options.base.length);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method: init.method, path, headers: init.headers, body });
    const isPublic =
      path.startsWith('/auth/') ||
      (init.method === 'GET' && path.startsWith('/identities/'));
    if (!isPublic && init.headers.Authorization !== 'Bearer access-token') {
      return reply(401, { error: 'not signed in' });
    }
    return route(init.method, path, body);
  };

  return {
    calls,
    grants,
    fetchFn,
    signedIn: () => signedIn,
    routes: () => calls.map((call) => `${call.method} ${call.path}`)
  };
}
