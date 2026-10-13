import { buildReleaseDigestEntries } from './release-digest-entries';

const pullRequest = {
  number: 42,
  url: 'https://github.com/6529-Collections/6529seize-backend/pull/42',
  title: 'Improve notifications',
  body: 'x'.repeat(5_000),
  contributors: ['Alice', 'alice', 'bob'],
  commit_messages: [],
  changed_files: [],
  candidate_services: ['pushNotificationsHandler', 'api', 'api']
};

describe('buildReleaseDigestEntries', () => {
  const input = {
    request: {
      repo: '6529-Collections/6529seize-backend',
      deployed_at: '2026-10-12T15:23:00.000Z'
    },
    context: { pull_requests: [pullRequest] },
    generatedNotes: [
      { number: 42, summary: 'Made notifications reliable.' },
      { number: 99, summary: 'Not in this release context.' }
    ],
    contributors: {
      mentionsByGithubLogin: new Map([
        ['alice', { profileId: 'alice-profile', handle: 'alice6529' }]
      ])
    },
    publicationId: 'a'.repeat(64)
  };

  it('records each summarized pull request with resolved contributors', () => {
    const [entry, ...rest] = buildReleaseDigestEntries(input);

    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{64}$/),
      repository: '6529-Collections/6529seize-backend',
      pull_request_number: 42,
      pull_request_title: 'Improve notifications',
      summary: 'Made notifications reliable.',
      contributors: [
        {
          github_login: 'Alice',
          handle: 'alice6529',
          profile_id: 'alice-profile'
        },
        { github_login: 'bob', handle: null, profile_id: null }
      ],
      services: ['api', 'pushNotificationsHandler'],
      publication_id: 'a'.repeat(64),
      deployed_at: Date.parse('2026-10-12T15:23:00.000Z')
    });
    expect(entry.pull_request_body).toHaveLength(4_000);
  });

  it('uses deterministic ids so regenerated notes update the same entry', () => {
    expect(buildReleaseDigestEntries(input)[0].id).toBe(
      buildReleaseDigestEntries(input)[0].id
    );
    expect(
      buildReleaseDigestEntries({ ...input, publicationId: 'b'.repeat(64) })[0]
        .id
    ).not.toBe(buildReleaseDigestEntries(input)[0].id);
  });

  it('rejects an invalid deployment timestamp', () => {
    expect(() =>
      buildReleaseDigestEntries({
        ...input,
        request: { ...input.request, deployed_at: 'yesterday' }
      })
    ).toThrow('valid deployed_at');
  });
});
