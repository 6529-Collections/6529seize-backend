import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { deviceSigningDb } from '@/api/device-signing/device-signing.db';
import { deviceSignedWritesService } from '@/api/device-signing/device-signed-writes.service';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { signForgeReport } from '@/drop-forge/drop-forge.report-signing';
import { dropsDb } from '@/drops/drops.db';

describe('Drop Forge report signing', () => {
  const grantId = `0x${'1'.repeat(64)}`;
  const wallet = `0x${'2'.repeat(40)}`;
  const ctx = { connection: { connection: 'report-transaction' } };
  const body = {
    wave_id: 'wave',
    drop_type: ApiDropType.Chat,
    hide_link_preview: true,
    parts: [{ content: 'Report', media: [] }],
    referenced_nfts: [],
    mentioned_users: [],
    metadata: [],
    signature: null
  };
  const keyPair = generateKeyPairSync('ed25519');
  const publicKey = keyPair.publicKey.export({ format: 'jwk' }).x!;
  const deviceKey = `0x${Buffer.from(publicKey, 'base64url').toString('hex')}`;

  beforeEach(() => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      DROP_FORGE_REPORT_SIGNING_KEY_ID: 'report-key',
      DROP_FORGE_REPORT_DEVICE_GRANT_ID: grantId
    });
    jest.spyOn(dropsDb, 'findDropById').mockResolvedValue({
      serial_no: 42,
      author_id: 'bot',
      wave_id: 'wave'
    } as never);
    jest.spyOn(deviceSigningDb, 'lockGrant').mockResolvedValue({
      id: grantId,
      wallet,
      device_key: deviceKey,
      scopes: 'post',
      expires_at: Date.now() + 60_000,
      revoked_at: null
    } as never);
    jest
      .spyOn(deviceSignedWritesService, 'recordCreatedDropSignature')
      .mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('uses the unique drop serial and signs the event digest as a raw Ed25519 message', async () => {
    const kms = jest
      .spyOn(KMSClient.prototype, 'send')
      .mockImplementation((command) => {
        if (!(command instanceof SignCommand) || !command.input.Message) {
          throw new Error('Expected a KMS signing request');
        }
        return Promise.resolve({
          Signature: sign(null, command.input.Message, keyPair.privateKey)
        });
      });

    await signForgeReport('drop', 'bot', body, ctx);

    const command = kms.mock.calls[0][0] as SignCommand;
    expect(command.input).toMatchObject({
      KeyId: 'report-key',
      MessageType: 'RAW',
      SigningAlgorithm: 'ED25519_SHA_512'
    });
    const [request, proofContext] = jest.mocked(
      deviceSignedWritesService.recordCreatedDropSignature
    ).mock.calls[0];
    expect(request).toMatchObject({
      dropId: 'drop',
      waveId: 'wave',
      body,
      envelope: { grant_id: grantId, seq: 42 }
    });
    expect(proofContext.connection).toBe(ctx.connection);
    expect(proofContext.authenticationContext.getActingAsId()).toBe('bot');
    expect(
      verify(
        null,
        command.input.Message!,
        keyPair.publicKey,
        Buffer.from(request.envelope.signature.slice(2), 'hex')
      )
    ).toBe(true);
  });

  it('rejects a malformed KMS signature before recording a proof', async () => {
    jest.spyOn(KMSClient.prototype, 'send').mockResolvedValue({
      Signature: Buffer.alloc(63)
    } as never);

    await expect(signForgeReport('drop', 'bot', body, ctx)).rejects.toThrow(
      'returned an invalid signature'
    );
    expect(
      deviceSignedWritesService.recordCreatedDropSignature
    ).not.toHaveBeenCalled();
  });
});
