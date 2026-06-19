export const HELP_BOT_HANDLE = '6529help';
export const HELP_BOT_BASE_URL = 'https://6529.io';
export const HELP_BOT_INDEX_URL = `${HELP_BOT_BASE_URL}/help-index.json`;
export const HELP_BOT_INDEX_FETCH_TIMEOUT_MS = 5000;
export const HELP_BOT_INDEX_CACHE_TTL_MS = 300_000;
export const HELP_BOT_BEDROCK_MODEL_ID =
  'anthropic.claude-3-sonnet-20240229-v1:0';
export const HELP_BOT_BEDROCK_TIMEOUT_MS = 4000;
export const HELP_BOT_PUBLIC_DATA_QUERY_TIMEOUT_MS = 5000;
export const HELP_BOT_PUBLIC_DATA_MAX_ROWS = 10;
export const HELP_BOT_KNOWLEDGE_VERSION = 'frontend-help-index-v1';
export const HELP_BOT_REPLY_QUEUE_NAME = 'help-bot-replies';
export const HELP_BOT_SEEN_REACTION = '👀';
export const HELP_BOT_SUCCESS_REACTION = '✅';
export const HELP_BOT_FAILURE_REACTION = '⚠️';

export const HELP_BOT_NO_RELIABLE_SOURCE_REPLY =
  "I saw this, but I couldn't find a reliable answer from the current 6529 docs. Try rephrasing, or ask in 6529 Tech Feedback.";

export const HELP_BOT_TECHNICAL_FAILURE_REPLY =
  'I saw this, but I hit a temporary issue while looking it up. Please try again in a minute.';
