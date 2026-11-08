import {
  E2EE_CIPHERSUITE,
  E2EE_CIPHERSUITE_AES128,
  E2EE_CIPHERSUITE_AES256,
  E2EE_CIPHERSUITES,
  isE2eeCiphersuite
} from '@/e2ee/e2ee.constants';

describe('E2EE ciphersuites', () => {
  it('accepts 0x004F and 0x004E and nothing else', () => {
    expect(E2EE_CIPHERSUITE_AES128).toBe(79);
    expect(E2EE_CIPHERSUITE_AES256).toBe(78);
    expect([...E2EE_CIPHERSUITES]).toEqual([79, 78]);
    expect(isE2eeCiphersuite(79)).toBe(true);
    expect(isE2eeCiphersuite(78)).toBe(true);
    for (const other of [0, 1, 77, 80, 0x0052, '79', null, undefined]) {
      expect(isE2eeCiphersuite(other)).toBe(false);
    }
  });

  it('defaults requests that name no suite to 0x004F', () => {
    expect(E2EE_CIPHERSUITE).toBe(E2EE_CIPHERSUITE_AES128);
  });
});
