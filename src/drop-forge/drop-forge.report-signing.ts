import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  canonicalizeEventBody,
  computeDeviceEventId,
  DEVICE_EVENT_ANCHOR,
  DEVICE_EVENT_KEY_TYPE,
  DEVICE_EVENT_KIND_VERSION,
  DeviceEventKind
} from '@/api/device-signing/device-event';
import { deserializeDeviceGrantScopes } from '@/api/device-signing/device-grant-message';
import { deviceSignedWritesService } from '@/api/device-signing/device-signed-writes.service';
import { deviceSigningDb } from '@/api/device-signing/device-signing.db';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { AuthenticationContext } from '@/auth-context';
import { getDropForgeReportSigningConfig } from '@/drop-forge/drop-forge.config';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { dropsDb } from '@/drops/drops.db';
import { RequestContext } from '@/request.context';

const kms = new KMSClient({
  maxAttempts: 2,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 2_000,
    requestTimeout: 5_000
  })
});

export async function signForgeReport(
  dropId: string,
  botId: string,
  body: ApiCreateDropRequest,
  ctx: RequestContext
): Promise<void> {
  if (!ctx.connection) {
    throw new LaunchSafetyError(
      'Drop Forge report signing requires its transaction'
    );
  }
  const { keyId, grantId } = getDropForgeReportSigningConfig();
  const drop = await dropsDb.findDropById(dropId, ctx.connection);
  // The two workers share one dedicated key. The database allocates a unique
  // drop serial for every post, including across workers and grant renewals.
  const seq = Number(drop?.serial_no);
  if (
    drop?.author_id !== botId ||
    drop.wave_id !== body.wave_id ||
    !Number.isSafeInteger(seq) ||
    seq < 1
  ) {
    throw new LaunchSafetyError(
      'Drop Forge report could not be identified for signing'
    );
  }
  const grant = await deviceSigningDb.lockGrant(grantId, ctx);
  const claimedTime = Date.now();
  if (
    grant?.revoked_at !== null ||
    Number(grant.expires_at) <= claimedTime ||
    !deserializeDeviceGrantScopes(grant.scopes).includes('post')
  ) {
    throw new LaunchSafetyError(
      'Drop Forge report signing grant is unavailable'
    );
  }

  const { bodyHash, bodySize } = canonicalizeEventBody(body);
  const eventId = computeDeviceEventId({
    kind: DeviceEventKind.POST,
    kindVersion: DEVICE_EVENT_KIND_VERSION,
    wave: body.wave_id,
    author: grant.wallet,
    keyType: DEVICE_EVENT_KEY_TYPE,
    deviceKey: grant.device_key,
    authRef: grantId,
    seq,
    anchor: DEVICE_EVENT_ANCHOR,
    claimedTime,
    refs: [],
    bodyHash,
    bodySize
  });
  const { Signature } = await kms.send(
    new SignCommand({
      KeyId: keyId,
      Message: Buffer.from(eventId.slice(2), 'hex'),
      MessageType: 'RAW',
      SigningAlgorithm: 'ED25519_SHA_512'
    })
  );
  if (Signature?.byteLength !== 64) {
    throw new LaunchSafetyError(
      'Drop Forge report signer returned an invalid signature'
    );
  }
  await deviceSignedWritesService.recordCreatedDropSignature(
    {
      dropId,
      waveId: body.wave_id,
      body,
      envelope: {
        grant_id: grantId,
        seq,
        claimed_time: claimedTime,
        signature: `0x${Buffer.from(Signature).toString('hex')}`
      }
    },
    {
      ...ctx,
      authenticationContext: AuthenticationContext.fromProfileId(botId)
    }
  );
}
