import { parseReleaseNoteMessage } from './index';

describe('parseReleaseNoteMessage', () => {
  it('parses a valid message', () => {
    expect(
      parseReleaseNoteMessage(
        JSON.stringify({
          repo: '6529-Collections/6529seize-frontend',
          workflow: 'Web Deploy - PROD',
          run_id: '123',
          run_number: '45',
          run_url: 'https://github.com/example/actions/runs/123',
          sha: 'abc123',
          branch: 'main',
          environment: 'prod',
          service: 'web',
          prompt: 'Generate release notes.',
          release_group_id: 'frontend-release',
          release_group_services: ['web'],
          deployed_at: '2026-07-13T11:38:00.000Z'
        })
      )
    ).toEqual({
      repo: '6529-Collections/6529seize-frontend',
      workflow: 'Web Deploy - PROD',
      run_id: '123',
      run_number: '45',
      run_url: 'https://github.com/example/actions/runs/123',
      sha: 'abc123',
      branch: 'main',
      environment: 'prod',
      service: 'web',
      prompt: 'Generate release notes.',
      release_group_id: 'frontend-release',
      release_group_services: ['web'],
      deployed_at: '2026-07-13T11:38:00.000Z'
    });
  });

  it('rejects a missing prompt', () => {
    expect(() =>
      parseReleaseNoteMessage(
        JSON.stringify({
          repo: '6529-Collections/6529seize-frontend',
          workflow: 'Web Deploy - PROD',
          run_id: '123',
          run_url: 'https://github.com/example/actions/runs/123',
          sha: 'abc123',
          environment: 'prod'
        })
      )
    ).toThrow('prompt is required');
  });
});
