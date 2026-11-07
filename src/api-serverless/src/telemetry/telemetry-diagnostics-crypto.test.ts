import { randomBytes } from 'node:crypto';
import {
  DIAGNOSTICS_CODE_PATTERN,
  decryptDiagnostics,
  encryptDiagnostics,
  isDiagnosticsEncryptionConfigured,
  newDiagnosticsCode,
  normalizeDiagnosticsCode
} from '@/api/telemetry/telemetry-diagnostics-crypto';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

describe('diagnostics encryption', () => {
  beforeEach(() => {
    process.env.TELEMETRY_DIAG_KEY = KEY_A;
    process.env.TELEMETRY_DIAG_KEY_ID = 'a';
    delete process.env.TELEMETRY_DIAG_PREVIOUS_KEYS;
  });

  afterAll(() => {
    delete process.env.TELEMETRY_DIAG_KEY;
    delete process.env.TELEMETRY_DIAG_KEY_ID;
    delete process.env.TELEMETRY_DIAG_PREVIOUS_KEYS;
  });

  it('round-trips and never stores plaintext', () => {
    const plaintext = Buffer.from('{"v":1,"note":"plain-probe"}');
    const stored = encryptDiagnostics(plaintext, 'D-AAAA-BBBB');
    expect(stored.key_id).toBe('a');
    expect(stored.ciphertext.toString('utf8')).not.toContain('plain-probe');
    expect(decryptDiagnostics(stored, 'D-AAAA-BBBB').equals(plaintext)).toBe(
      true
    );
  });

  it('binds the ciphertext to its code', () => {
    const stored = encryptDiagnostics(Buffer.from('x'), 'D-AAAA-BBBB');
    expect(() => decryptDiagnostics(stored, 'D-AAAA-CCCC')).toThrow();
  });

  it('reads bundles written with a previous key after rotation', () => {
    const stored = encryptDiagnostics(Buffer.from('old'), 'D-AAAA-BBBB');
    process.env.TELEMETRY_DIAG_KEY = KEY_B;
    process.env.TELEMETRY_DIAG_KEY_ID = 'b';
    expect(() => decryptDiagnostics(stored, 'D-AAAA-BBBB')).toThrow();
    process.env.TELEMETRY_DIAG_PREVIOUS_KEYS = `a:${KEY_A}`;
    expect(decryptDiagnostics(stored, 'D-AAAA-BBBB').toString()).toBe('old');
  });

  it('is unavailable without a 32-byte key', () => {
    process.env.TELEMETRY_DIAG_KEY = Buffer.alloc(16).toString('base64');
    expect(isDiagnosticsEncryptionConfigured()).toBe(false);
    delete process.env.TELEMETRY_DIAG_KEY;
    expect(isDiagnosticsEncryptionConfigured()).toBe(false);
    expect(() => encryptDiagnostics(Buffer.from('x'), 'D-AAAA-BBBB')).toThrow();
  });
});

describe('diagnostics codes', () => {
  it('uses the short Crockford format', () => {
    const codes = new Set<string>();
    for (let index = 0; index < 200; index++) {
      const code = newDiagnosticsCode();
      expect(code).toMatch(DIAGNOSTICS_CODE_PATTERN);
      codes.add(code);
    }
    expect(codes.size).toBe(200);
  });

  it('normalizes what people type', () => {
    expect(normalizeDiagnosticsCode(' d-7k3q-9xw2 ')).toBe('D-7K3Q-9XW2');
    expect(normalizeDiagnosticsCode('7K3Q-9XW2')).toBe('D-7K3Q-9XW2');
    expect(normalizeDiagnosticsCode('D-7K3O-9XWI')).toBe('D-7K30-9XW1');
    expect(normalizeDiagnosticsCode('D-7K3Q-9XW')).toBeNull();
    expect(normalizeDiagnosticsCode('../etc')).toBeNull();
  });
});
