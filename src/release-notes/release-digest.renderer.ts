import type {
  ReleaseDigestDraft,
  ReleaseDigestItem,
  ReleaseDigestSourceEntry
} from './release-digest.writer';

export interface ReleaseDigestCredit {
  readonly githubLogin: string;
  readonly handle: string | null;
  readonly profileId: string | null;
}

export interface MentionedDigestProfile {
  readonly profileId: string;
  readonly handle: string;
}

export interface RenderedReleaseDigest {
  readonly content: string;
  readonly mentionedProfiles: readonly MentionedDigestProfile[];
}

interface RenderInput {
  readonly digestDate: string;
  readonly credits: readonly ReleaseDigestCredit[];
  readonly detailsUrl: string;
}

const GITHUB_BOT_LOGIN_PATTERN = /\[bot\]$|^dependabot$|^github-actions$/i;

function escapeMarkdownLabel(label: string): string {
  return label.replace(/[[\]]/g, (character) => `\\${character}`);
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatItem(item: ReleaseDigestItem, sectionTitle: string): string {
  const repeatsSection = item.area.toLowerCase() === sectionTitle.toLowerCase();
  return item.area && !repeatsSection
    ? `- **${item.area}:** ${item.text}`
    : `- ${item.text}`;
}

function formatSection(
  title: string,
  items: readonly ReleaseDigestItem[]
): string[] {
  return items.length
    ? ['', `**${title}**`, ...items.map((item) => formatItem(item, title))]
    : [];
}

function formatList(values: readonly string[]): string {
  if (values.length <= 1) {
    return values.join('');
  }
  return `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
}

function buildCountsSentence(draft: ReleaseDigestDraft): string {
  const parts = [
    draft.newItems.length
      ? plural(
          draft.newItems.length,
          'new or changed feature',
          'new or changed features'
        )
      : null,
    draft.fixedItems.length
      ? plural(draft.fixedItems.length, 'fix', 'fixes')
      : null,
    draft.securityItems.length
      ? plural(draft.securityItems.length, 'security fix', 'security fixes')
      : null,
    draft.behindTheScenesKeys.length
      ? plural(
          draft.behindTheScenesKeys.length,
          'behind-the-scenes change',
          'behind-the-scenes changes'
        )
      : null
  ].filter((part): part is string => part !== null);
  return `Today: ${formatList(parts)}. Everything below is live on 6529.io.`;
}

function hasVisibleChanges(draft: ReleaseDigestDraft): boolean {
  return (
    draft.newItems.length +
      draft.fixedItems.length +
      draft.securityItems.length +
      draft.knownIssues.length >
    0
  );
}

function buildBehindTheScenesLine(draft: ReleaseDigestDraft): string[] {
  const count = draft.behindTheScenesKeys.length;
  if (!count) {
    return [];
  }
  const text =
    draft.behindTheScenes ||
    `${plural(count, 'internal change', 'internal changes')} to tooling, tests, and infrastructure. No action needed.`;
  return ['', `**Behind the scenes:** ${text}`];
}

function buildCredits(credits: readonly ReleaseDigestCredit[]): {
  readonly line: string[];
  readonly mentionedProfiles: MentionedDigestProfile[];
} {
  const labels: string[] = [];
  const mentionedProfiles: MentionedDigestProfile[] = [];
  const seen = new Set<string>();
  for (const credit of credits) {
    if (GITHUB_BOT_LOGIN_PATTERN.test(credit.githubLogin)) {
      continue;
    }
    const identity = (credit.profileId ?? credit.githubLogin).toLowerCase();
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    if (credit.handle && credit.profileId) {
      labels.push(`@[${credit.handle}]`);
      mentionedProfiles.push({
        profileId: credit.profileId,
        handle: credit.handle
      });
    } else {
      labels.push(
        `[@${escapeMarkdownLabel(credit.githubLogin)}](https://github.com/${credit.githubLogin})`
      );
    }
  }
  return {
    line: labels.length ? ['', `Thanks ${formatList(labels)}.`] : [],
    mentionedProfiles
  };
}

function buildBuildersLine(buildersNote: string, detailsUrl: string): string[] {
  const details = `Each change with its pull request is in [Deploys · Production](${detailsUrl}).`;
  return [
    '',
    `**For builders:** ${buildersNote ? `${buildersNote} ` : ''}${details}`
  ];
}

export function renderReleaseDigest(
  draft: ReleaseDigestDraft,
  { digestDate, credits, detailsUrl }: RenderInput
): RenderedReleaseDigest {
  const visible = hasVisibleChanges(draft);
  const opening = visible
    ? [`**${draft.headline}**`, '', buildCountsSentence(draft)]
    : ['Nothing changes on screen today.'];
  const { line: creditLine, mentionedProfiles } = buildCredits(credits);
  const content = [
    `### Daily release notes · ${digestDate}`,
    '',
    ...opening,
    ...formatSection('New and changed', draft.newItems),
    ...formatSection('Fixed', draft.fixedItems),
    ...formatSection('Security', draft.securityItems),
    ...formatSection('Known issues', draft.knownIssues),
    ...buildBehindTheScenesLine(draft),
    ...creditLine,
    ...buildBuildersLine(draft.buildersNote, detailsUrl)
  ].join('\n');
  return { content, mentionedProfiles };
}

function getRepositoryTitle(repository: string): string {
  const name = repository.split('/').pop() ?? repository;
  const label = name.replace(/^6529seize-/, '').replace(/^6529-/, '');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Used when the model is unavailable: one plain line per change. */
export function renderFallbackReleaseDigest(
  entries: readonly ReleaseDigestSourceEntry[],
  { digestDate, credits, detailsUrl }: RenderInput
): RenderedReleaseDigest {
  const { line: creditLine, mentionedProfiles } = buildCredits(credits);
  const content = [
    `### Daily release notes · ${digestDate}`,
    '',
    `${plural(entries.length, 'change', 'changes')} went live on 6529.io today.`,
    '',
    ...entries.map(
      (entry) =>
        `- **${getRepositoryTitle(entry.repository)}:** ${entry.summary}`
    ),
    ...creditLine,
    ...buildBuildersLine('', detailsUrl)
  ].join('\n');
  return { content, mentionedProfiles };
}
