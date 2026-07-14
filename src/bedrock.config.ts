import { env } from './env';

export const DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID =
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
export const DEFAULT_HELP_BOT_BEDROCK_MODEL_ID =
  DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID;

function readTrimmedEnv(name: string): string | null {
  return env.getStringOrNull(name)?.trim() || null;
}

export function getConfiguredBedrockAnthropicModelId(
  serviceModelEnvName: string,
  defaultModelId: string
): string {
  return readTrimmedEnv(serviceModelEnvName) ?? defaultModelId;
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
