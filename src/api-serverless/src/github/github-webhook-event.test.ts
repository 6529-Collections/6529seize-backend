import {
  buildGitHubWebhookDedupeKey,
  parseGitHubWebhookEvent
} from '@/api/github/github-webhook-event';

const ISSUE_URL = 'https://github.com/6529-Collections/test/issues/123';
const PR_URL = 'https://github.com/6529-Collections/test/pull/456';

describe('github webhook event parsing', () => {
  it.each(['opened', 'reopened'] as const)(
    'parses an issue %s event',
    (action) => {
      expect(
        parseGitHubWebhookEvent(
          {
            action,
            issue: {
              html_url: ISSUE_URL
            }
          },
          'issues'
        )
      ).toEqual({
        kind: 'issue',
        action,
        htmlUrl: ISSUE_URL
      });
    }
  );

  it.each(['opened', 'reopened'] as const)(
    'parses a pull request %s event',
    (action) => {
      expect(
        parseGitHubWebhookEvent(
          {
            action,
            pull_request: {
              html_url: PR_URL
            }
          },
          'pull_request'
        )
      ).toEqual({
        kind: 'pull_request',
        action,
        htmlUrl: PR_URL
      });
    }
  );

  it('ignores unsupported actions', () => {
    expect(
      parseGitHubWebhookEvent(
        {
          action: 'closed',
          issue: {
            html_url: ISSUE_URL
          }
        },
        'issues'
      )
    ).toBeNull();
  });

  it('ignores unsupported event names', () => {
    expect(
      parseGitHubWebhookEvent(
        {
          action: 'opened',
          pull_request: {
            html_url: PR_URL
          }
        },
        'pull_request_review'
      )
    ).toBeNull();
  });

  it('ignores missing or malformed URLs', () => {
    expect(
      parseGitHubWebhookEvent(
        {
          action: 'opened',
          issue: {}
        },
        'issues'
      )
    ).toBeNull();

    expect(
      parseGitHubWebhookEvent(
        {
          action: 'opened',
          pull_request: {
            html_url: 'not a url'
          }
        },
        'pull_request'
      )
    ).toBeNull();
  });

  it('uses delivery id for dedupe keys when present', () => {
    const event = parseGitHubWebhookEvent(
      {
        action: 'opened',
        issue: {
          html_url: ISSUE_URL
        }
      },
      'issues'
    );

    expect(event).not.toBeNull();
    if (!event) {
      throw new Error('Expected GitHub webhook event');
    }

    expect(buildGitHubWebhookDedupeKey(event, ' delivery-123 ')).toBe(
      'gh-webhook:delivery:delivery-123'
    );
  });

  it('falls back to type action and url for dedupe keys', () => {
    const event = parseGitHubWebhookEvent(
      {
        action: 'reopened',
        pull_request: {
          html_url: PR_URL
        }
      },
      'pull_request'
    );

    expect(event).not.toBeNull();
    if (!event) {
      throw new Error('Expected GitHub webhook event');
    }

    expect(buildGitHubWebhookDedupeKey(event, undefined)).toBe(
      `gh-webhook:pull_request:reopened:${PR_URL}`
    );
  });
});
