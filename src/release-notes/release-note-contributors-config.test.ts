import {
  GITHUB_TO_6529_HANDLES,
  isGithubContributorLogin
} from './release-note-contributors.config';

describe('GITHUB_TO_6529_HANDLES', () => {
  it('maps GitHub contributors to their 6529.io handles', () => {
    expect(GITHUB_TO_6529_HANDLES).toEqual({
      brookr: 'brookr',
      gelatogenesis: 'GelatoGenesis',
      prxt6529: 'prxt0',
      punk6529: 'punk6529',
      ragnep: 'ragne',
      simo6529: 'simo'
    });
  });

  it('accepts only GitHub-shaped contributor logins', () => {
    expect(isGithubContributorLogin('GelatoGenesis')).toBe(true);
    expect(isGithubContributorLogin('dependabot[bot]')).toBe(true);
    expect(isGithubContributorLogin('trailing-')).toBe(false);
    expect(isGithubContributorLogin('double--hyphen')).toBe(false);
  });
});
