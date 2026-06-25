import { env } from '@/env';

export const HELP_BOT_HANDLE = 'help6529';
export function resolveHelpBotBaseUrl(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  sentryEnvironment: string | undefined = process.env.SENTRY_ENVIRONMENT
): string {
  const normalizedSentryEnvironment = sentryEnvironment?.toLowerCase() ?? '';
  return nodeEnv === 'development' ||
    normalizedSentryEnvironment.includes('staging')
    ? 'https://staging.6529.io'
    : 'https://6529.io';
}

export const HELP_BOT_BASE_URL = resolveHelpBotBaseUrl();
export const HELP_BOT_INDEX_URL = `${HELP_BOT_BASE_URL}/help-index.json`;
export const HELP_BOT_INDEX_FETCH_TIMEOUT_MS = 5000;
export const HELP_BOT_INDEX_CACHE_TTL_MS = 300_000;
export const HELP_BOT_CALENDAR_FETCH_TIMEOUT_MS = 5000;
export const HELP_BOT_BEDROCK_MODEL_ID =
  'anthropic.claude-3-sonnet-20240229-v1:0';
export const HELP_BOT_BEDROCK_TIMEOUT_MS = 4000;
export const HELP_BOT_PUBLIC_DATA_QUERY_TIMEOUT_MS = 5000;
export const HELP_BOT_PUBLIC_DATA_MAX_ROWS = 10;
export const HELP_BOT_KNOWLEDGE_VERSION = 'frontend-help-index-v1';
export const HELP_BOT_REPLY_QUEUE_NAME = 'help-bot-replies';
export const HELP_BOT_SEEN_REACTION = ':eyes:';
export const HELP_BOT_SUCCESS_REACTION = ':white_check_mark:';
export const HELP_BOT_FAILURE_REACTION = ':warning:';
export const HELP_BOT_SPAM_REACTION = ':no_entry:';
export const HELP_BOT_INSUFFICIENT_CREDITS_REACTION = ':low_battery:';
export const HELP_BOT_USER_SPAM_WINDOW_MS = 60_000;
export const HELP_BOT_USER_SPAM_MAX_TRIGGERS_PER_WINDOW = 5;
export const HELP_BOT_TECH_TEAM_HANDLES_ENV = 'HELP_BOT_TECH_TEAM_HANDLES';
export const HELP_BOT_CREDIT_CATEGORY = 'Help6529 Credits';
export const HELP_BOT_RESERVED_CREDIT_CATEGORY_MESSAGE =
  'Help6529 Credits is a reserved REP category managed by help6529.';
export const HELP_BOT_SIGNUP_CREDIT_GRANT = 5;
export const HELP_BOT_PROFILE_SETUP_CREDIT_GRANT = 5;
export const HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT = 5;
export const HELP_BOT_QUESTION_CREDIT_COST = 1;

export const HELP_BOT_NO_RELIABLE_SOURCE_BASE_REPLY =
  "I don't have enough knowledge to help you here.";
export const HELP_BOT_OUT_OF_SCOPE_REPLY =
  'I can only help with 6529 product questions.';
export const HELP_BOT_INSUFFICIENT_CREDITS_REPLY =
  'You need at least 1 Help6529 Credit REP to ask a question. Help6529 Credits are REP in the `Help6529 Credits` category managed by help6529 for signup, profile setup, and daily activity.';

export const HELP_BOT_TECHNICAL_FAILURE_REPLY =
  'I saw this, but I hit a temporary issue while looking it up. Please try again in a minute.';

function normalizeMentionHandle(handle: string): string | null {
  const normalized = handle.trim().replace(/^@/, '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(normalized)) {
    return null;
  }
  return normalized;
}

export function isHelpBotCreditCategory(
  category: string | null | undefined
): boolean {
  return (
    category?.trim().toLowerCase() === HELP_BOT_CREDIT_CATEGORY.toLowerCase()
  );
}

export function getHelpBotTechTeamMentionHandles(): string[] {
  const seen = new Set<string>();
  const handles: string[] = [];
  const rawHandles = env.getStringOrNull(HELP_BOT_TECH_TEAM_HANDLES_ENV);
  for (const rawHandle of rawHandles?.split(/[;,]/) ?? []) {
    const handle = normalizeMentionHandle(rawHandle);
    if (!handle) {
      continue;
    }
    const key = handle.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    handles.push(handle);
  }
  return handles;
}

export function buildHelpBotNoReliableSourceReply(
  mentionedHandles: readonly string[] = getHelpBotTechTeamMentionHandles()
): string {
  if (!mentionedHandles.length) {
    return HELP_BOT_NO_RELIABLE_SOURCE_BASE_REPLY;
  }
  const mentions = mentionedHandles.map((handle) => `@[${handle}]`).join(' ');
  return `${HELP_BOT_NO_RELIABLE_SOURCE_BASE_REPLY} I'm flagging this so the tech team can double-check: ${mentions}`;
}
