import { DropForgeJobEntity } from '@/entities/IDropForgeLaunch';
import { CustomApiCompliantException } from '@/exceptions';
import {
  decryptPreparationAuth,
  encryptPreparationAuth,
  PreparationAuthRequired,
  withPreparationAuth
} from '@/drop-forge/drop-forge.preparation-auth';

const oldSecret = process.env.JWT_SECRET;
const job = (): DropForgeJobEntity =>
  Object.assign(new DropForgeJobEntity(), {
    id: 'job-id',
    contract: '0xcreator',
    claim_id: 1,
    kind: 'PROCESS_ALL',
    plan_id: 'plan',
    phase_id: null,
    phase_ids: ['a', 'b', 'c']
  });
beforeEach(() => {
  process.env.JWT_SECRET = 'operator-handoff-test-secret';
});
afterEach(() => {
  if (oldSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = oldSecret;
});
it('encrypts the operator authorization with random nonces and job-specific authentication', () => {
  const current = job();
  current.encrypted_auth = encryptPreparationAuth(
    current,
    'Bearer operator-token'
  );
  expect(current.encrypted_auth).not.toContain('operator-token');
  expect(encryptPreparationAuth(current, 'Bearer operator-token')).not.toBe(
    current.encrypted_auth
  );
  expect(decryptPreparationAuth(current)).toBe('Bearer operator-token');
  for (const change of [
    { id: 'other-job' },
    { claim_id: 2 },
    { contract: '0xother' },
    { phase_ids: ['b', 'a', 'c'] }
  ]) {
    expect(() => decryptPreparationAuth({ ...current, ...change })).toThrow(
      PreparationAuthRequired
    );
  }
});
it('does not expose credentials or crypto errors when ciphertext or the secret changes', () => {
  const current = job();
  current.encrypted_auth = encryptPreparationAuth(
    current,
    'Bearer operator-token'
  );
  process.env.JWT_SECRET = 'rotated-secret';
  expect(() => decryptPreparationAuth(current)).toThrow('Sign in to resume');
  expect(() =>
    decryptPreparationAuth({ ...current, encrypted_auth: 'bad' })
  ).toThrow(PreparationAuthRequired);
  expect(() => encryptPreparationAuth(current, '')).toThrow(
    PreparationAuthRequired
  );
  delete process.env.JWT_SECRET;
  expect(() => decryptPreparationAuth(current)).toThrow(
    'protection is unavailable'
  );
});
it.each([401, 403])(
  'sanitizes EMMA authorization rejection %i into a resumable state',
  async (status) => {
    await expect(
      withPreparationAuth(async () => {
        throw new CustomApiCompliantException(
          status,
          'sensitive upstream response'
        );
      })
    ).rejects.toThrow('Sign in to resume');
  }
);
it('does not classify outages or invalid data as a request to authenticate again', async () => {
  const error = new CustomApiCompliantException(503, 'unavailable');
  await expect(
    withPreparationAuth(async () => {
      throw error;
    })
  ).rejects.toBe(error);
});
