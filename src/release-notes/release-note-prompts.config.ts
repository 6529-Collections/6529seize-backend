export const RELEASE_NOTES_PROMPT_PATH =
  'ops/release-notes/release-notes.prompt.md';
export const DESKTOP_RELEASE_NOTES_PROMPT_PATH =
  'ops/release-notes/desktop-release-notes.prompt.md';

const RELEASE_NOTE_PROMPTS_BY_REPOSITORY = new Map([
  ['6529seize-backend', RELEASE_NOTES_PROMPT_PATH],
  ['6529seize-frontend', RELEASE_NOTES_PROMPT_PATH],
  ['6529-core', DESKTOP_RELEASE_NOTES_PROMPT_PATH]
]);

export function isAllowedReleaseNotesPrompt(
  repo: string,
  promptPath: string
): boolean {
  const repoName = repo.split('/').pop()?.toLowerCase();
  return Boolean(
    repoName && RELEASE_NOTE_PROMPTS_BY_REPOSITORY.get(repoName) === promptPath
  );
}
