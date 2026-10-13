import {
  renderFallbackReleaseDigest,
  renderReleaseDigest
} from './release-digest.renderer';
import type { ReleaseDigestDraft } from './release-digest.writer';

const renderInput = {
  digestDate: '2026-10-12',
  credits: [
    { githubLogin: 'GelatoGenesis', handle: 'GelatoGenesis', profileId: 'p1' },
    { githubLogin: 'gelatogenesis', handle: 'GelatoGenesis', profileId: 'p1' },
    { githubLogin: 'dependabot[bot]', handle: null, profileId: null },
    { githubLogin: 'outside-dev', handle: null, profileId: null },
    { githubLogin: 'punk6529', handle: 'punk6529', profileId: 'p2' }
  ],
  detailsUrl: 'https://6529.io/waves/deploy-wave'
};

const draft: ReleaseDigestDraft = {
  headline: 'Saved access groups now show profile names',
  newItems: [
    {
      area: 'Waves',
      text: 'Saved access groups show handles and pictures.',
      entryKeys: ['E1']
    }
  ],
  fixedItems: [
    {
      area: 'Chat',
      text: 'Fixed messages disappearing in busy waves.',
      entryKeys: ['E2']
    },
    {
      area: '',
      text: 'Fixed PDF previews on iPhone.',
      entryKeys: ['E3']
    }
  ],
  securityItems: [
    {
      area: 'Security',
      text: 'Tightened admin access checks; no action needed.',
      entryKeys: ['E4']
    }
  ],
  knownIssues: [],
  behindTheScenes: 'Faster automated checks.',
  behindTheScenesKeys: ['E5', 'E6'],
  buildersNote: 'Backend: auth-before-cache.'
};

describe('renderReleaseDigest', () => {
  it('renders a fixed daily shape with counts, sections, credits and builder links', () => {
    const rendered = renderReleaseDigest(draft, renderInput);

    expect(rendered.content).toBe(
      [
        '### Daily release notes · 2026-10-12',
        '',
        '**Saved access groups now show profile names**',
        '',
        'Today: 1 new or changed feature, 2 fixes, 1 security fix and 2 behind-the-scenes changes. Everything below is live on 6529.io.',
        '',
        '**New and changed**',
        '- **Waves:** Saved access groups show handles and pictures.',
        '',
        '**Fixed**',
        '- **Chat:** Fixed messages disappearing in busy waves.',
        '- Fixed PDF previews on iPhone.',
        '',
        '**Security**',
        '- Tightened admin access checks; no action needed.',
        '',
        '**Behind the scenes:** Faster automated checks.',
        '',
        'Thanks @[GelatoGenesis], [@outside-dev](https://github.com/outside-dev) and @[punk6529].',
        '',
        '**For builders:** Backend: auth-before-cache. Each change with its pull request is in [Deploys · Production](https://6529.io/waves/deploy-wave).'
      ].join('\n')
    );
    expect(rendered.mentionedProfiles).toEqual([
      { profileId: 'p1', handle: 'GelatoGenesis' },
      { profileId: 'p2', handle: 'punk6529' }
    ]);
  });

  it('renders a quiet day without empty sections', () => {
    const rendered = renderReleaseDigest(
      {
        ...draft,
        headline: 'A quiet day for visible changes',
        newItems: [],
        fixedItems: [],
        securityItems: [],
        behindTheScenes: '',
        behindTheScenesKeys: ['E1']
      },
      { ...renderInput, credits: [] }
    );

    expect(rendered.content).toContain('Nothing changes on screen today.');
    expect(rendered.content).toContain(
      '**Behind the scenes:** 1 internal change to tooling, tests, and infrastructure. No action needed.'
    );
    expect(rendered.content).not.toContain('**Fixed**');
    expect(rendered.content).not.toContain('Thanks');
    expect(rendered.mentionedProfiles).toEqual([]);
  });

  it('renders a plain fallback when the model is unavailable', () => {
    const rendered = renderFallbackReleaseDigest(
      [
        {
          key: 'E1',
          repository: '6529-Collections/6529seize-frontend',
          services: [],
          title: 'Title',
          summary: 'Made switching waves smoother.',
          body: null
        },
        {
          key: 'E2',
          repository: '6529-Collections/6529seize-backend',
          services: ['api'],
          title: 'Title',
          summary: 'Added drop size limits.',
          body: null
        }
      ],
      renderInput
    );

    expect(rendered.content).toContain('2 changes went live on 6529.io today.');
    expect(rendered.content).toContain(
      '- **Frontend:** Made switching waves smoother.'
    );
    expect(rendered.content).toContain(
      '- **Backend:** Added drop size limits.'
    );
    expect(rendered.content).toContain('[Deploys · Production]');
  });
});
