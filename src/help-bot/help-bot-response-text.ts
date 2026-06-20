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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/([\\[\]])/g, '\\$1');
}

function isGenericLinkLabel(label: string): boolean {
  return /^(?:more\s+info|learn\s+more|source|details|read\s+more|here)$/i.test(
    label.trim()
  );
}

export function formatHelpBotMarkdownLink({
  label,
  url
}: {
  readonly label: string;
  readonly url: string;
}): string {
  const safeLabel = escapeMarkdownLinkLabel(label.trim() || 'More info');
  return `[${safeLabel}](${url})`;
}

export function ensureCanonicalMarkdownLink({
  text,
  canonicalUrl,
  label
}: {
  readonly text: string;
  readonly canonicalUrl: string;
  readonly label: string;
}): string {
  const compact = text.replace(/\n{3,}/g, '\n\n');
  const markdownLink = formatHelpBotMarkdownLink({ label, url: canonicalUrl });
  const markdownLinkPattern = new RegExp(
    `\\[([^\\]]+)\\]\\(${escapeRegExp(canonicalUrl)}\\)`,
    'g'
  );
  let sawCanonicalMarkdownLink = false;
  const withPreferredLinkLabels = compact.replace(
    markdownLinkPattern,
    (match, existingLabel: string) => {
      sawCanonicalMarkdownLink = true;
      return isGenericLinkLabel(existingLabel) ? markdownLink : match;
    }
  );
  if (sawCanonicalMarkdownLink) {
    return withPreferredLinkLabels;
  }
  if (withPreferredLinkLabels.includes(canonicalUrl)) {
    return withPreferredLinkLabels.split(canonicalUrl).join(markdownLink);
  }
  return `${withPreferredLinkLabels}\n\nMore info: ${markdownLink}`;
}

export function stripHelpBotSelfIntro(text: string): string {
  let stripped = text.trim();
  for (const pattern of HELP_BOT_SELF_INTRO_PATTERNS) {
    stripped = stripped.replace(pattern, '').trim();
  }
  return stripped;
}
