import {
  DESKTOP_RELEASE_NOTES_PROMPT_PATH,
  getAllowedCiRepositoryName,
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
      isAllowedReleaseNotesPrompt(
        '6529-Collections/6529-core',
        DESKTOP_RELEASE_NOTES_PROMPT_PATH
      )
    ).toBe(true);
    expect(
      isAllowedReleaseNotesPrompt('6529-core', RELEASE_NOTES_PROMPT_PATH)
    ).toBe(false);
    expect(
      isAllowedReleaseNotesPrompt('other-repo', RELEASE_NOTES_PROMPT_PATH)
    ).toBe(false);
    expect(
      isAllowedReleaseNotesPrompt('6529seize-backend', 'unreviewed.prompt.md')
    ).toBe(false);
  });
});

describe('getAllowedCiRepositoryName', () => {
  it.each([
    ['6529seize-backend', '6529seize-backend'],
    ['6529seize-frontend', '6529seize-frontend'],
    ['6529-core', '6529-core'],
    ['6529-Collections/6529seize-backend', '6529seize-backend'],
    ['6529-Collections/6529-core', '6529-core']
  ])('accepts %s', (repo, name) => {
    expect(getAllowedCiRepositoryName(repo)).toBe(name);
  });

  it.each([
    'other/6529seize-backend',
    '6529-collections/6529seize-backend',
    '6529-Collections/6529-CORE',
    '6529-Collections/6529seize-backend/extra',
    '6529-Collections/../other/repo',
    '6529seize-backend/',
    '/6529seize-backend',
    'other-repo',
    ''
  ])('rejects %j', (repo) => {
    expect(getAllowedCiRepositoryName(repo)).toBeNull();
    expect(isAllowedReleaseNotesPrompt(repo, RELEASE_NOTES_PROMPT_PATH)).toBe(
      false
    );
  });
});
