import {
  GetSecretValueCommand,
  SecretsManagerClient
} from '@aws-sdk/client-secrets-manager';

/**
 * The secret 6529.io's functions load into their environment when a
 * container starts (src/env.ts). A warm container keeps that copy, so a
 * setting fixed in the secret is not in its environment until it restarts.
 */
export const LAMBDAS_SECRET_ID = 'prod/lambdas';

const ATTEMPTS = 3;

/** One key of a secret as it is now. */
export interface FreshSecretValue {
  readonly secretId: string;
  readonly key: string;
  /** The value, or undefined when the secret has no such key. */
  readonly value: string | undefined;
}

/**
 * Reads one key of the lambdas secret from Secrets Manager now, not from
 * the environment a warm container loaded at its start, so a fix to the
 * secret is seen by the next run. Values are read as the environment gets
 * them: as strings.
 */
export async function readFreshSecretValue(
  client: Pick<SecretsManagerClient, 'send'>,
  key: string,
  secretId: string = LAMBDAS_SECRET_ID,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<FreshSecretValue> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let text: string | undefined;
    try {
      const answer = await client.send(
        new GetSecretValueCommand({ SecretId: secretId })
      );
      text = answer.SecretString;
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) await sleep(attempt * 500);
      continue;
    }
    if (typeof text !== 'string') {
      throw new Error(`The secret ${secretId} has no text value`);
    }
    let values: Record<string, unknown>;
    try {
      values = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A parse error's message can quote the secret's text: never pass it on.
      throw new Error(`The secret ${secretId} is not valid JSON`);
    }
    const value = values?.[key];
    return {
      secretId,
      key,
      value: value === undefined || value === null ? undefined : String(value)
    };
  }
  throw lastError;
}
