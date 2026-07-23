export const RELEASE_NOTES_PROMPT_PATH =
  'ops/release-notes/release-notes.prompt.md';

const SUPPORTED_RELEASE_NOTE_REPOSITORIES = new Set([
  '6529seize-backend',
  '6529seize-frontend'
]);

export function isAllowedReleaseNotesPrompt(
  repo: string,
  promptPath: string
): boolean {
  const repoName = repo.split('/').pop()?.toLowerCase();
  return (
    Boolean(repoName && SUPPORTED_RELEASE_NOTE_REPOSITORIES.has(repoName)) &&
    promptPath === RELEASE_NOTES_PROMPT_PATH
  );
}
