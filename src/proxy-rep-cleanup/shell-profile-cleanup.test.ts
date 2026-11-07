import {
  isIgnoredTable,
  parseShellLine,
  shellLine
} from './shell-profile-cleanup';

describe('shell profile cleanup helpers', () => {
  it('ignores only ad-hoc copies and scratch tables', () => {
    for (const table of [
      'community_groups_bckp_28_03_2025',
      'drop_voter_states_backup_20250506',
      'profile_activity_logs_bckup_20251505',
      'analysis_9_08_2025',
      'pfa_temp',
      'ppp2'
    ]) {
      expect(isIgnoredTable(table)).toBe(true);
    }
    for (const table of ['profiles', 'drops', 'backups_index', 'ratings']) {
      expect(isIgnoredTable(table)).toBe(false);
    }
  });

  it('round-trips shell lines and rejects malformed ones', () => {
    const shell = { profile_id: 'p-1', address: '0xabc' };
    expect(parseShellLine(shellLine(shell))).toEqual(shell);
    expect(() => parseShellLine('p-1')).toThrow();
    expect(() => parseShellLine('p-1\t0xabc\textra')).toThrow();
  });
});
