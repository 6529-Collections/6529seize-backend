import {
  isAllowedReleaseNotesPrompt,
  RELEASE_NOTES_PROMPT_PATH
} from './release-note-prompts.config';

describe('release note prompt configuration', () => {
  it('allows only the reviewed prompt path for supported repositories', () => {
    expect(
      isAllowedReleaseNotesPrompt(
        '6529-Collections/6529seize-frontend',
        RELEASE_NOTES_PROMPT_PATH
      )
    ).toBe(true);
    expect(
      isAllowedReleaseNotesPrompt(
        '6529seize-backend',
        RELEASE_NOTES_PROMPT_PATH
      )
    ).toBe(true);
    expect(
      isAllowedReleaseNotesPrompt('other-repo', RELEASE_NOTES_PROMPT_PATH)
    ).toBe(false);
    expect(
      isAllowedReleaseNotesPrompt('6529seize-backend', 'unreviewed.prompt.md')
    ).toBe(false);
  });
});
