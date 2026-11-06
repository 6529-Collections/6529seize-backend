import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomInt
} from 'node:crypto';
import { env } from '@/env';

/**
 * Diagnostics bundles are stored encrypted with AES-256-GCM under a key that
 * lives only in the API's secrets (`TELEMETRY_DIAG_KEY`, 32 bytes, base64).
 * `TELEMETRY_DIAG_KEY_ID` names the key so it can be rotated: a bundle keeps
 * the id it was written with, and `TELEMETRY_DIAG_PREVIOUS_KEYS` (comma list
 * of `id:base64key`) keeps older keys readable until their bundles expire.
 */
export interface DiagnosticsCiphertext {
  readonly key_id: string;
  readonly iv: Buffer;
  readonly auth_tag: Buffer;
  readonly ciphertext: Buffer;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const DEFAULT_KEY_ID = 'k1';
// Crockford base32 without I, L, O and U, so codes read back unambiguously.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const DIAGNOSTICS_CODE_PATTERN =
  /^D-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

function decodeKey(value: string | null): Buffer | null {
  if (!value) {
    return null;
  }
  const key = Buffer.from(value.trim(), 'base64');
  return key.length === KEY_BYTES ? key : null;
}

function currentKey(): { id: string; key: Buffer } | null {
  const key = decodeKey(env.getStringOrNull('TELEMETRY_DIAG_KEY'));
  if (!key) {
    return null;
  }
  return {
    id: env.getStringOrNull('TELEMETRY_DIAG_KEY_ID') ?? DEFAULT_KEY_ID,
    key
  };
}

function keyById(id: string): Buffer | null {
  const current = currentKey();
  if (current?.id === id) {
    return current.key;
  }
  for (const entry of env.getStringArray('TELEMETRY_DIAG_PREVIOUS_KEYS', ',')) {
    const separator = entry.indexOf(':');
    if (separator > 0 && entry.slice(0, separator).trim() === id) {
      return decodeKey(entry.slice(separator + 1));
    }
  }
  return null;
}

export function isDiagnosticsEncryptionConfigured(): boolean {
  return currentKey() !== null;
}

export function encryptDiagnostics(
  plaintext: Buffer,
  aad: string
): DiagnosticsCiphertext {
  const current = currentKey();
  if (!current) {
    throw new Error('Diagnostics encryption key is not configured');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', current.key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { key_id: current.id, iv, auth_tag: cipher.getAuthTag(), ciphertext };
}

export function decryptDiagnostics(
  stored: DiagnosticsCiphertext,
  aad: string
): Buffer {
  const key = keyById(stored.key_id);
  if (!key) {
    throw new Error('Diagnostics decryption key is not available');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, stored.iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(stored.auth_tag);
  return Buffer.concat([decipher.update(stored.ciphertext), decipher.final()]);
}

/** A short code such as `D-7K3Q-9XW2` (40 random bits). */
export function newDiagnosticsCode(): string {
  let chars = '';
  for (let index = 0; index < 8; index++) {
    chars += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `D-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Accepts lowercase and confusable letters (I/L as 1, O as 0). */
export function normalizeDiagnosticsCode(value: string): string | null {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  const withPrefix = normalized.startsWith('D-')
    ? normalized
    : `D-${normalized}`;
  return DIAGNOSTICS_CODE_PATTERN.test(withPrefix) ? withPrefix : null;
}
