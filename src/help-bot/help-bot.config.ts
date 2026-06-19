import { env } from '@/env';

export const HELP_BOT_HANDLE = '6529help';
export const HELP_BOT_KNOWLEDGE_VERSION = 'frontend-help-index-v1';
export const HELP_BOT_SEEN_REACTION = '👀';
export const HELP_BOT_SUCCESS_REACTION = '✅';
export const HELP_BOT_FAILURE_REACTION = '⚠️';

export const HELP_BOT_NO_RELIABLE_SOURCE_REPLY =
  "I saw this, but I couldn't find a reliable answer from the current 6529 docs. Try rephrasing, or ask in 6529 Tech Feedback.";

export const HELP_BOT_TECHNICAL_FAILURE_REPLY =
  'I saw this, but I hit a temporary issue while looking it up. Please try again in a minute.';

export interface HelpBotConfig {
  readonly enabled: boolean;
  readonly botProfileId: string | null;
  readonly queueUrl: string | null;
  readonly bedrockModelId: string | null;
  readonly baseUrl: string;
  readonly knowledgeIndexUrl: string;
  readonly knowledgeIndexFetchTimeoutMs: number;
  readonly knowledgeIndexCacheTtlMs: number;
}

function parseEnabled(value: string | null): boolean {
  if (!value) {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function normalizeBaseUrl(value: string | null): string {
  const baseUrl = value?.trim() || 'https://6529.io';
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function normalizePositiveInteger(
  value: string | null,
  fallback: number
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getHelpBotConfig(): HelpBotConfig {
  const baseUrl = normalizeBaseUrl(env.getStringOrNull('HELP_BOT_BASE_URL'));
  return {
    enabled: parseEnabled(env.getStringOrNull('HELP_BOT_ENABLED')),
    botProfileId: env.getStringOrNull('HELP_BOT_PROFILE_ID')?.trim() || null,
    queueUrl: env.getStringOrNull('HELP_BOT_SQS_URL')?.trim() || null,
    bedrockModelId:
      env.getStringOrNull('HELP_BOT_BEDROCK_MODEL_ID')?.trim() || null,
    baseUrl,
    knowledgeIndexUrl:
      env.getStringOrNull('HELP_BOT_INDEX_URL')?.trim() ||
      `${baseUrl}/help-index.json`,
    knowledgeIndexFetchTimeoutMs: normalizePositiveInteger(
      env.getStringOrNull('HELP_BOT_INDEX_FETCH_TIMEOUT_MS'),
      5000
    ),
    knowledgeIndexCacheTtlMs: normalizePositiveInteger(
      env.getStringOrNull('HELP_BOT_INDEX_CACHE_TTL_MS'),
      300_000
    )
  };
}

export function isHelpBotRuntimeReady(config: HelpBotConfig): boolean {
  return config.enabled && !!config.botProfileId;
}

export function isHelpBotTriggerRuntimeReady(config: HelpBotConfig): boolean {
  return isHelpBotRuntimeReady(config) && !!config.queueUrl;
}
