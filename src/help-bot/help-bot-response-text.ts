const HELP_BOT_HANDLE_PATTERN = '@?(?:\\[6529help\\]|6529help)';

const HELP_BOT_SELF_INTRO_PATTERNS = [
  new RegExp(
    `^\\s*(?:hey|hi|hello|gm)[,\\s]+${HELP_BOT_HANDLE_PATTERN}\\s+(?:here(?:'s)?|is here)\\s*[!:.,-]*\\s*`,
    'i'
  ),
  new RegExp(
    `^\\s*${HELP_BOT_HANDLE_PATTERN}\\s+(?:here(?:'s)?|is here)\\s*[!:.,-]*\\s*`,
    'i'
  ),
  new RegExp(`^\\s*${HELP_BOT_HANDLE_PATTERN}\\s*[:：-]+\\s*`, 'i')
];

export function stripHelpBotSelfIntro(text: string): string {
  let stripped = text.trim();
  for (const pattern of HELP_BOT_SELF_INTRO_PATTERNS) {
    stripped = stripped.replace(pattern, '').trim();
  }
  return stripped;
}
