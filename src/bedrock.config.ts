import { env } from './env';

export const BEDROCK_ANTHROPIC_MODEL_ID_ENV = 'BEDROCK_ANTHROPIC_MODEL_ID';
export const DEFAULT_BEDROCK_ANTHROPIC_MODEL_ID =
  'anthropic.claude-3-5-sonnet-20241022-v2:0';

function readTrimmedEnv(name: string): string | null {
  const value = env.getStringOrNull(name)?.trim();
  return value ? value : null;
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
  const value = Number(rawValue.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
