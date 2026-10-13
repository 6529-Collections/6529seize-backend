import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes
} from 'node:crypto';
import { DropForgeJobEntity } from '@/entities/IDropForgeLaunch';
import { ApiCompliantException } from '@/exceptions';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';

export class PreparationAuthRequired extends LaunchSafetyError {
  constructor() {
    super(
      'EMMA access expired or was denied. Sign in to resume this processing job.'
    );
  }
}

function credentialKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret)
    throw new LaunchSafetyError(
      'Preparation credential protection is unavailable'
    );
  return Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      'drop-forge-preparation',
      'operator-authorization-v1',
      32
    )
  );
}

function credentialScope(job: DropForgeJobEntity): Buffer {
  const phases =
    typeof job.phase_ids === 'string'
      ? JSON.parse(job.phase_ids)
      : job.phase_ids;
  return Buffer.from(
    JSON.stringify([
      job.id,
      job.contract.toLowerCase(),
      Number(job.claim_id),
      job.kind,
      job.plan_id,
      job.phase_id,
      phases ?? null
    ])
  );
}

export function encryptPreparationAuth(
  job: DropForgeJobEntity,
  authorization: string
): string {
  if (!/^Bearer\s+\S+$/i.test(authorization) || authorization.length > 16384)
    throw new PreparationAuthRequired();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialKey(), iv);
  cipher.setAAD(credentialScope(job));
  const ciphertext = Buffer.concat([
    cipher.update(authorization, 'utf8'),
    cipher.final()
  ]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64')
  ].join('.');
}

export function decryptPreparationAuth(job: DropForgeJobEntity): string {
  if (!job.encrypted_auth) throw new PreparationAuthRequired();
  const key = credentialKey();
  try {
    const [version, iv, tag, ciphertext, extra] = job.encrypted_auth.split('.');
    if (version !== 'v1' || !iv || !tag || !ciphertext || extra)
      throw new PreparationAuthRequired();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64')
    );
    decipher.setAAD(credentialScope(job));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    throw new PreparationAuthRequired();
  }
}

export async function withPreparationAuth<T>(
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof ApiCompliantException &&
      [401, 403].includes(error.getStatusCode())
    )
      throw new PreparationAuthRequired();
    throw error;
  }
}
