import { env } from './env';

export const BEDROCK_ANTHROPIC_MODEL_ID_ENV = 'BEDROCK_ANTHROPIC_MODEL_ID';
export const DEFAULT_BEDROCK_ANTHROPIC_MODEL_ID =
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

function readTrimmedEnv(name: string): string | null {
  return env.getStringOrNull(name)?.trim() || null;
}

export function getConfiguredBedrockAnthropicModelId(
  serviceOverrideEnvName?: string
): string {
  return (
    (serviceOverrideEnvName ? readTrimmedEnv(serviceOverrideEnvName) : null) ??
    readTrimmedEnv(BEDROCK_ANTHROPIC_MODEL_ID_ENV) ??
    DEFAULT_BEDROCK_ANTHROPIC_MODEL_ID
  );
}

export function getPositiveIntEnvOrDefault(
  name: string,
  defaultValue: number
): number {
  const rawValue = env.getStringOrNull(name);
  if (!rawValue?.trim()) {
    return defaultValue;
  }
  const trimmedValue = rawValue.trim();
  if (!/^\d+$/.test(trimmedValue)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(trimmedValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
