import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { Logger } from '@/logging';
import {
  derivedCauseWindows,
  derivedCauses,
  isDerivedCause,
  legacyOutputEnabled,
  loggedWindows,
  notificationsReadTable,
  notifyViewMode,
  writesLegacyCopy,
  writesViewRow
} from './notify-view-flags';

const KEYS = [
  'NOTIFY_VIEW_MODE',
  'NOTIFY_DERIVED_CAUSES',
  'NOTIFY_LEGACY_OUTPUT'
] as const;
const REP = IdentityNotificationCause.IDENTITY_REP;
const VOTED = IdentityNotificationCause.DROP_VOTED;
const CUT = 1_795_000_000_000;

describe('notification view flags', () => {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    for (const key of KEYS) delete process.env[key];
  });
  afterAll(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults to today: off, nothing derived, readers on identity_notifications', () => {
    expect(notifyViewMode()).toBe('off');
    expect(derivedCauses().size).toBe(0);
    expect(notificationsReadTable()).toBe('identity_notifications');
    expect(legacyOutputEnabled()).toBe(true);
    expect(writesViewRow(REP, CUT)).toBe(false);
  });

  it.each([
    ['shadow', 'shadow'],
    [' ON ', 'on'],
    ['true', 'off'],
    ['', 'off']
  ])('reads mode %p as %p', (value, mode) => {
    process.env.NOTIFY_VIEW_MODE = value;
    expect(notifyViewMode()).toBe(mode);
  });

  it('ignores derived causes while the mode is off, so every old writer runs', () => {
    process.env.NOTIFY_DERIVED_CAUSES = 'IDENTITY_REP@0';
    expect(isDerivedCause(REP)).toBe(false);
    expect(writesLegacyCopy(REP, CUT)).toBe(false);
  });

  it('takes CAUSE@cutMs and ignores items without a valid cut, so their old writers keep writing', () => {
    process.env.NOTIFY_VIEW_MODE = 'shadow';
    process.env.NOTIFY_DERIVED_CAUSES = ` identity_rep@0, DROP_VOTED@${CUT} ,NOPE@1,IDENTITY_NIC,DROP_BOOSTED@x,DROP_REACTED@1@2,WAVE_CREATED@-5,ALL_DROPS@`;
    expect(loggedWindows(derivedCauseWindows())).toEqual({
      IDENTITY_REP: [[0, null]],
      DROP_VOTED: [[CUT, null]]
    });
    expect(isDerivedCause(IdentityNotificationCause.IDENTITY_NIC)).toBe(false);
  });

  it('reports, once per value, a derived cause that no feed derives', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      process.env.NOTIFY_VIEW_MODE = 'shadow';
      process.env.NOTIFY_DERIVED_CAUSES = `DROP_VOTED@${CUT + 7}`;
      derivedCauseWindows();
      derivedCauseWindows();
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toContain(
        'NOTIFY_DERIVED_CAUSE_WITHOUT_FEED'
      );
    } finally {
      error.mockRestore();
    }
  });

  it("warns once about a cut earlier than this instance's start", () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      process.env.NOTIFY_VIEW_MODE = 'shadow';
      process.env.NOTIFY_DERIVED_CAUSES = `DROP_VOTED@${CUT + 11},IDENTITY_REP@${Date.now() + 3_600_000}`;
      derivedCauseWindows();
      derivedCauseWindows();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(
        'NOTIFY_DERIVED_CAUSE_CUT_BEFORE_START'
      );
      expect(warn.mock.calls[0][0]).toContain(`DROP_VOTED@${CUT + 11}`);
      expect(warn.mock.calls[0][0]).not.toContain('IDENTITY_REP');
    } finally {
      warn.mockRestore();
    }
  });

  it('hands a cause back and forth at the ends of its windows, in any order', () => {
    process.env.NOTIFY_VIEW_MODE = 'on';
    process.env.NOTIFY_DERIVED_CAUSES = `DROP_VOTED@${CUT + 20},DROP_VOTED@${CUT}..${CUT + 10}`;
    expect(loggedWindows(derivedCauseWindows())).toEqual({
      DROP_VOTED: [
        [CUT, CUT + 10],
        [CUT + 20, null]
      ]
    });
    for (const [at, derived] of [
      [CUT - 1, false],
      [CUT, true],
      [CUT + 9, true],
      [CUT + 10, false],
      [CUT + 19, false],
      [CUT + 20, true]
    ] as const) {
      expect([at, isDerivedCause(VOTED, at)]).toEqual([at, derived]);
      expect([at, writesViewRow(VOTED, at)]).toEqual([at, derived]);
    }
  });

  it('ignores a window that overlaps an earlier one of its cause, or ends before it starts', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      process.env.NOTIFY_VIEW_MODE = 'on';
      process.env.NOTIFY_DERIVED_CAUSES = [
        `DROP_VOTED@${CUT}..${CUT + 10}`,
        `DROP_VOTED@${CUT + 5}..${CUT + 30}`,
        `IDENTITY_REP@${CUT}`,
        `IDENTITY_REP@${CUT + 50}`,
        `IDENTITY_NIC@${CUT + 9}..${CUT + 9}`,
        `IDENTITY_NIC@${CUT}..${CUT}..${CUT + 1}`
      ].join(',');
      expect(loggedWindows(derivedCauseWindows())).toEqual({
        DROP_VOTED: [[CUT, CUT + 10]],
        IDENTITY_REP: [[CUT, null]]
      });
      const ignored = error.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('NOTIFY_DERIVED_CAUSES_IGNORED'));
      expect(ignored).toContain(`DROP_VOTED@${CUT + 5}..${CUT + 30}`);
      expect(ignored).toContain(`IDENTITY_REP@${CUT + 50}`);
      expect(ignored).toContain(`IDENTITY_NIC@${CUT + 9}..${CUT + 9}`);
    } finally {
      error.mockRestore();
    }
  });

  it('reports no missing feed for a cause whose windows have all closed', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      process.env.NOTIFY_VIEW_MODE = 'on';
      process.env.NOTIFY_DERIVED_CAUSES = `DROP_VOTED@${CUT + 1}..${CUT + 2}`;
      derivedCauseWindows();
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('hands a cause over at its cut: old writer before, deriver from it', () => {
    process.env.NOTIFY_VIEW_MODE = 'shadow';
    process.env.NOTIFY_DERIVED_CAUSES = `DROP_VOTED@${CUT}`;
    expect(isDerivedCause(VOTED, CUT - 1)).toBe(false);
    expect(isDerivedCause(VOTED, CUT)).toBe(true);
    expect(writesLegacyCopy(VOTED, CUT - 1)).toBe(false);
    expect(writesLegacyCopy(VOTED, CUT)).toBe(true);
  });

  it('writes every rule in shadow, and only owned rows in on', () => {
    process.env.NOTIFY_DERIVED_CAUSES = `DROP_VOTED@${CUT}`;
    process.env.NOTIFY_VIEW_MODE = 'shadow';
    expect(writesViewRow(REP, CUT)).toBe(true);
    expect(writesViewRow(VOTED, CUT - 1)).toBe(true);
    expect(notificationsReadTable()).toBe('identity_notifications');
    process.env.NOTIFY_VIEW_MODE = 'on';
    expect(writesViewRow(REP, CUT)).toBe(false);
    expect(writesViewRow(VOTED, CUT - 1)).toBe(false);
    expect(writesViewRow(VOTED, CUT)).toBe(true);
    expect(notificationsReadTable()).toBe('notification_view');
  });

  it('writes legacy copies in on until legacy output stops', () => {
    process.env.NOTIFY_DERIVED_CAUSES = 'DROP_VOTED@0';
    process.env.NOTIFY_VIEW_MODE = 'on';
    expect(writesLegacyCopy(VOTED, CUT)).toBe(true);
    expect(writesLegacyCopy(REP, CUT)).toBe(false);
    process.env.NOTIFY_LEGACY_OUTPUT = 'false';
    expect(writesLegacyCopy(VOTED, CUT)).toBe(false);
  });
});
