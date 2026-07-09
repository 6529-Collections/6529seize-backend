jest.mock('@/api/drops/drop-creation.api.service', () => ({
  dropCreationService: {
    createDrop: jest.fn()
  }
}));

jest.mock('@/identities/identities.db', () => ({
  identitiesDb: {
    getIdsByHandles: jest.fn()
  }
}));

import fc from 'fast-check';
import {
  CiPipelineAlertService,
  formatMarkdownLink,
  normalizeConfiguredHandle,
  normalizeTargetEnvironment,
  parseProfileHandles,
  truncate
} from './ci-pipeline-alert.service';

const baseRequest = {
  repo: '6529seize-frontend',
  workflow: 'Web Deploy - PROD',
  status: 'failure' as const,
  title: 'Seize PROD WEB DEPLOY: CI pipeline is broken!!!',
  description: 'abc123 - Fix deploy',
  run_id: '12345',
  run_number: '6082',
  run_url:
    'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345',
  sha: 'abc1234567890',
  branch: 'main',
  environment: 'production',
  service: 'web'
};

describe('CiPipelineAlertService', () => {
  let originalEnv: Record<string, string | undefined>;
  let dropCreationApiService: {
    createDrop: jest.Mock;
    toggleHideLinkPreview: jest.Mock;
  };
  let identitiesRepository: { getIdsByHandles: jest.Mock };

  beforeEach(() => {
    originalEnv = {
      CI_PIPELINES_STAGING_WAVE_ID: process.env.CI_PIPELINES_STAGING_WAVE_ID,
      CI_PIPELINES_PROD_WAVE_ID: process.env.CI_PIPELINES_PROD_WAVE_ID,
      CI_PIPELINES_BOT_PROFILE_ID: process.env.CI_PIPELINES_BOT_PROFILE_ID,
      CI_PIPELINES_FAILURE_MENTION_PROFILE_HANDLES:
        process.env.CI_PIPELINES_FAILURE_MENTION_PROFILE_HANDLES
    };
    process.env.CI_PIPELINES_STAGING_WAVE_ID = 'staging-wave';
    process.env.CI_PIPELINES_PROD_WAVE_ID = 'prod-wave';
    process.env.CI_PIPELINES_BOT_PROFILE_ID = 'bot-profile';
    process.env.CI_PIPELINES_FAILURE_MENTION_PROFILE_HANDLES =
      '@alice, @[Bob], alice, missing';
    dropCreationApiService = {
      createDrop: jest.fn().mockResolvedValue({ id: 'drop-1' }),
      toggleHideLinkPreview: jest.fn().mockResolvedValue({})
    };
    identitiesRepository = {
      getIdsByHandles: jest.fn().mockResolvedValue({
        ALICE: 'profile-1',
        Bob: 'profile-2'
      })
    };
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('keeps truncated arbitrary content within the target length', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 3, max: 120 }),
        (value, maxLength) => {
          const truncated = truncate(value, maxLength);

          expect(truncated.length).toBeLessThanOrEqual(maxLength);
          if (value.length <= maxLength) {
            expect(truncated).toBe(value);
          } else {
            expect(truncated).toBe(`${value.slice(0, maxLength - 3)}...`);
          }
        }
      )
    );
  });

  it('escapes arbitrary markdown link labels', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (label, url) => {
        const escapedLabel = label
          .split('[')
          .join(String.raw`\[`)
          .split(']')
          .join(String.raw`\]`);

        expect(formatMarkdownLink(label, url)).toBe(
          `[${escapedLabel}](${url})`
        );
      })
    );
  });

  it('normalizes arbitrary configured profile handles', () => {
    const handleCharacters =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split(
        ''
      );
    const handleArbitrary = fc
      .array(fc.constantFrom(...handleCharacters), {
        minLength: 1,
        maxLength: 30
      })
      .map((chars) => chars.join(''));

    fc.assert(
      fc.property(handleArbitrary, (handle) => {
        expect(normalizeConfiguredHandle(` @${handle} `)).toBe(handle);
        expect(normalizeConfiguredHandle(` @[${handle}] `)).toBe(handle);
      })
    );
  });

  it('dedupes arbitrary configured profile handles case-insensitively', () => {
    const handleCharacters =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split(
        ''
      );
    const handleArbitrary = fc
      .array(fc.constantFrom(...handleCharacters), {
        minLength: 1,
        maxLength: 20
      })
      .map((chars) => chars.join(''));

    fc.assert(
      fc.property(fc.array(handleArbitrary, { maxLength: 20 }), (handles) => {
        const input = handles
          .flatMap((handle) => [` @${handle} `, ` @[${handle.toUpperCase()}] `])
          .join(',');
        const parsedHandles = parseProfileHandles(input);
        const normalizedHandles = parsedHandles.map((handle) =>
          handle.toLowerCase()
        );

        expect(new Set(normalizedHandles).size).toBe(parsedHandles.length);
        for (const parsedHandle of parsedHandles) {
          expect(parsedHandle).not.toMatch(/^@/);
        }
      })
    );
  });

  it('normalizes arbitrary target environment casing and spacing', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('staging', 'prod', 'production'),
        fc.constantFrom('', ' ', '  ', '\t', '\n'),
        fc.constantFrom('', ' ', '  ', '\t', '\n'),
        (environment, prefixWhitespace, suffixWhitespace) => {
          const paddedEnvironment = `${prefixWhitespace}${environment.toUpperCase()}${suffixWhitespace}`;
          const expected = environment === 'production' ? 'prod' : environment;

          expect(normalizeTargetEnvironment(paddedEnvironment)).toBe(expected);
        }
      )
    );
  });

  it('posts failures with configured profile mentions', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );
    const ctx = {};

    await service.postAlert(baseRequest, ctx as any);

    expect(identitiesRepository.getIdsByHandles).toHaveBeenCalledWith([
      'alice',
      'Bob',
      'missing'
    ]);
    expect(dropCreationApiService.createDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: 'bot-profile',
        representativeId: 'bot-profile',
        hideLinkPreview: true,
        createDropRequest: expect.objectContaining({
          wave_id: 'prod-wave',
          title: null,
          metadata: [],
          mentioned_users: [
            {
              mentioned_profile_id: 'profile-1',
              handle_in_content: 'ALICE'
            },
            {
              mentioned_profile_id: 'profile-2',
              handle_in_content: 'Bob'
            }
          ],
          parts: [
            expect.objectContaining({
              content: expect.stringContaining(
                [
                  '[PROD] Deploy Failed',
                  '',
                  'cc @[ALICE] @[Bob]',
                  '',
                  'Service: Frontend - web',
                  'Workflow: Web Deploy - PROD',
                  'Branch: main',
                  'Commit: [abc12345](https://github.com/6529-Collections/6529seize-frontend/commit/abc1234567890)',
                  'Run: [#6082](https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345)'
                ].join('\n')
              )
            })
          ]
        })
      }),
      expect.objectContaining({
        authenticationContext: expect.objectContaining({
          authenticatedProfileId: 'bot-profile'
        })
      })
    );
    expect(dropCreationApiService.toggleHideLinkPreview).not.toHaveBeenCalled();
  });

  it('routes staging successes without resolving or adding mentions', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        status: 'success',
        title: 'Seize Lambda staging api DEPLOY CI pipeline complete',
        environment: 'staging'
      },
      {}
    );

    expect(identitiesRepository.getIdsByHandles).not.toHaveBeenCalled();
    expect(dropCreationApiService.createDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        hideLinkPreview: true,
        createDropRequest: expect.objectContaining({
          wave_id: 'staging-wave',
          title: null,
          metadata: [],
          mentioned_users: [],
          parts: [
            expect.objectContaining({
              content: expect.stringContaining(
                [
                  '[STAGING] Deploy Succeeded',
                  '',
                  'Service: Frontend - web',
                  'Workflow: Web Deploy - PROD',
                  'Branch: main',
                  'Commit: [abc12345](https://github.com/6529-Collections/6529seize-frontend/commit/abc1234567890)',
                  'Run: [#6082](https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345)'
                ].join('\n')
              )
            })
          ]
        })
      }),
      expect.anything()
    );
    expect(
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
        .parts[0].content
    ).toBe(
      [
        '[STAGING] Deploy Succeeded',
        '',
        'Service: Frontend - web',
        'Workflow: Web Deploy - PROD',
        'Branch: main',
        'Commit: [abc12345](https://github.com/6529-Collections/6529seize-frontend/commit/abc1234567890)',
        'Run: [#6082](https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345)'
      ].join('\n')
    );
    expect(
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest.parts[0].content.startsWith(
        '\n'
      )
    ).toBe(false);
    expect(
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
        .parts[0].content
    ).not.toContain('cc @[');
    expect(dropCreationApiService.toggleHideLinkPreview).not.toHaveBeenCalled();
  });
});
