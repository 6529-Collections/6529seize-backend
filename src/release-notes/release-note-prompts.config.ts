export const RELEASE_NOTES_PROMPT_PATH =
  'ops/release-notes/release-notes.prompt.md';
export const DESKTOP_RELEASE_NOTES_PROMPT_PATH =
  'ops/release-notes/desktop-release-notes.prompt.md';

const RELEASE_NOTE_PROMPTS_BY_REPOSITORY = new Map([
  ['6529seize-backend', RELEASE_NOTES_PROMPT_PATH],
  ['6529seize-frontend', RELEASE_NOTES_PROMPT_PATH],
  ['6529-core', DESKTOP_RELEASE_NOTES_PROMPT_PATH]
]);

export const CI_REPOSITORY_OWNER = '6529-Collections';

/** The repositories that may report CI alerts and request release notes. */
export const CI_REPOSITORY_NAMES: readonly string[] = Array.from(
  RELEASE_NOTE_PROMPTS_BY_REPOSITORY.keys()
);

/**
 * The repository name when `repo` is exactly an allowlisted repository name
 * or `6529-Collections/<name>`; null otherwise.
 */
export function getAllowedCiRepositoryName(repo: string): string | null {
  const parts = repo.split('/');
  const [owner, name] =
    parts.length === 1 ? [CI_REPOSITORY_OWNER, parts[0]] : parts;
  if (
    parts.length > 2 ||
    owner !== CI_REPOSITORY_OWNER ||
    !name ||
    !CI_REPOSITORY_NAMES.includes(name)
  ) {
    return null;
  }
  return name;
}

export function isAllowedReleaseNotesPrompt(
  repo: string,
  promptPath: string
): boolean {
  const repoName = getAllowedCiRepositoryName(repo);
  return Boolean(
    repoName && RELEASE_NOTE_PROMPTS_BY_REPOSITORY.get(repoName) === promptPath
  );
}
