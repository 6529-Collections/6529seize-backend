import * as fc from 'fast-check';
import {
  e2eeClaimKeyPackagesSchema,
  e2eeDeviceLookupSchema,
  e2eeLogQuerySchema,
  e2eeRegisterDeviceSchema,
  e2eeSendMessageSchema,
  e2eeSubmitEntrySchema,
  validateE2ee
} from '@/api/e2ee/e2ee.validation';
import { E2EE_ZERO_32 } from '@/e2ee/e2ee-digests';
import { E2eeApiException } from '@/e2ee/e2ee-errors';

const HEX32 = `0x${'ab'.repeat(32)}`;
const SIG = `0x${'cd'.repeat(64)}`;

function rejects(value: unknown, schema: Parameters<typeof validateE2ee>[1]) {
  let caught: unknown;
  try {
    validateE2ee(value, schema);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(E2eeApiException);
  expect((caught as E2eeApiException).code).toBe('E2EE_BAD_REQUEST');
}

const entry = {
  kind: 'commit',
  epoch: 3,
  data: 'AAAA',
  entry_hash: HEX32,
  epoch_commitment: HEX32,
  next_commit_key: HEX32,
  signature: SIG,
  sender_device_key: HEX32
};

describe('E2EE request validation', () => {
  it('accepts a well-formed entry and rejects malformed fields', () => {
    expect(validateE2ee(entry, e2eeSubmitEntrySchema)).toEqual(entry);
    rejects({ ...entry, kind: 'update' }, e2eeSubmitEntrySchema);
    rejects({ ...entry, epoch: 2 ** 32 }, e2eeSubmitEntrySchema);
    rejects({ ...entry, epoch: -1 }, e2eeSubmitEntrySchema);
    rejects(
      { ...entry, entry_hash: HEX32.toUpperCase() },
      e2eeSubmitEntrySchema
    );
    rejects({ ...entry, signature: SIG.slice(0, -2) }, e2eeSubmitEntrySchema);
    rejects({ ...entry, extra: true }, e2eeSubmitEntrySchema);
    rejects(
      { ...entry, welcome: { data: 'AAAA', targets: [] } },
      e2eeSubmitEntrySchema
    );
    expect(
      validateE2ee(
        { ...entry, epoch_commitment: E2EE_ZERO_32 },
        e2eeSubmitEntrySchema
      )
    ).toBeTruthy();
  });

  it('accepts only 32-byte lowercase hex device keys', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 70 }), (candidate) => {
        const valid = /^0x[0-9a-f]{64}$/.test(candidate);
        const value = { ...entry, sender_device_key: candidate };
        if (valid) {
          expect(validateE2ee(value, e2eeSubmitEntrySchema)).toBeTruthy();
        } else {
          rejects(value, e2eeSubmitEntrySchema);
        }
      })
    );
  });

  it('validates registration, claims, messages and log queries', () => {
    const registration = {
      grant: {
        wallet: `0x${'1'.repeat(40)}`,
        device_key: HEX32,
        ciphersuite: 1,
        issued_at: 1760270400,
        expires_at: 1775822400,
        origin: '6529.io'
      },
      wallet_signature: '0x',
      platform: 'phone'
    };
    expect(validateE2ee(registration, e2eeRegisterDeviceSchema)).toBeTruthy();
    rejects({ ...registration, platform: 'tv' }, e2eeRegisterDeviceSchema);
    rejects(
      { ...registration, grant: { ...registration.grant, ciphersuite: 2 } },
      e2eeRegisterDeviceSchema
    );
    rejects(
      { ...registration, wallet_signature: '0x123' },
      e2eeRegisterDeviceSchema
    );
    rejects(
      {
        targets: [{ profile_id: 'a' }, { profile_id: 'a' }],
        claimer_device_key: HEX32
      },
      e2eeClaimKeyPackagesSchema
    );
    rejects(
      {
        epoch: 1,
        data: 'AAAA',
        epoch_fp: 'xyz',
        sender_device_key: HEX32
      },
      e2eeSendMessageSchema
    );
    expect(
      validateE2ee({ device_key: HEX32, after_seq: '5' }, e2eeLogQuerySchema)
    ).toEqual({ device_key: HEX32, after_seq: 5 });
    expect(validateE2ee({ device_key: HEX32 }, e2eeLogQuerySchema)).toEqual({
      device_key: HEX32,
      after_seq: 0
    });
    rejects({ device_key: HEX32, limit: 201 }, e2eeLogQuerySchema);
    expect(
      validateE2ee({ profile_ids: ['a'] }, e2eeDeviceLookupSchema)
    ).toEqual({ profile_ids: ['a'] });
    rejects({}, e2eeDeviceLookupSchema);
    rejects({ profile_ids: [], device_keys: [] }, e2eeDeviceLookupSchema);
    rejects({ device_keys: ['0x12'] }, e2eeDeviceLookupSchema);
    rejects(
      { profile_ids: Array.from({ length: 201 }, (_, i) => `p${i}`) },
      e2eeDeviceLookupSchema
    );
  });
});
