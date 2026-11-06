import { AuthenticationContext } from '@/auth-context';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { ProfileActivityLogsSearchRequest } from './profile-activity-logs-api.service';
import {
  decodeNicActivityCursor,
  encodeNicActivityCursor,
  nicActivityContext,
  getNicActivityPageRequest
} from './profile-nic-activity.cursor';

const request: ProfileActivityLogsSearchRequest = {
  activityScope: 'NIC',
  profileId: 'subject',
  includeProfileIdToIncoming: true,
  group_id: null,
  order: 'desc',
  pageRequest: { page: 1, page_size: 10 }
};
const context = nicActivityContext(request, {});
const position = { id: 'tied-aB', createdAt: '2026-11-05 12:00:00' };

describe('NIC cursor contract', () => {
  it('leaves legacy query normalization outside NIC validation', () => {
    expect(
      getNicActivityPageRequest({
        profile: 'subject',
        page: '1x',
        page_size: '0'
      })
    ).toBeNull();
  });
  it.each([position, { id: 'null-time', createdAt: null }])(
    'roundtrips positions including nullable historical timestamps',
    (point) => {
      expect(
        decodeNicActivityCursor(
          encodeNicActivityCursor(point, context, 2),
          context,
          2
        )
      ).toEqual(point);
    }
  );
  it.each(['!', 'e30', 'a'.repeat(2049)])(
    'rejects malformed cursors',
    (cursor) => {
      expect(() => decodeNicActivityCursor(cursor, context, 2)).toThrow(
        'Invalid NIC activity cursor'
      );
    }
  );
  it('rejects changed filters, direction, profile, page size, viewer and page', () => {
    const cursor = encodeNicActivityCursor(position, context, 2);
    const changes = [
      { ...request, profileId: 'other' },
      { ...request, includeProfileIdToIncoming: false },
      { ...request, logType: [ProfileActivityLogType.PFP_EDIT] },
      { ...request, pageRequest: { page: 2, page_size: 50 } }
    ];
    for (const change of changes)
      expect(() =>
        decodeNicActivityCursor(cursor, nicActivityContext(change, {}), 2)
      ).toThrow();
    expect(() =>
      decodeNicActivityCursor(
        cursor,
        nicActivityContext(request, {
          authenticationContext: AuthenticationContext.fromProfileId('owner')
        }),
        2
      )
    ).toThrow();
    expect(() => decodeNicActivityCursor(cursor, context, 3)).toThrow();
  });
  it('rejects invalid dates and oversized IDs', () => {
    for (const point of [
      { id: 'id', createdAt: '2026-02-31 12:00:00' },
      { id: 'x'.repeat(101), createdAt: null }
    ]) {
      expect(() =>
        decodeNicActivityCursor(
          encodeNicActivityCursor(point, context, 2),
          context,
          2
        )
      ).toThrow();
    }
  });
  it.each([
    { profile: undefined },
    { target: 'second' },
    { rating_matter: 'CIC' },
    { order: 'asc' },
    { order: 'other' },
    { group_id: 'group' },
    { category: 'category' },
    { page: '2' },
    { page_size: '501' },
    { activity_scope: 'REP' }
  ])(
    'rejects unsupported combinations rather than altering other activity views',
    (invalid) => {
      expect(() =>
        getNicActivityPageRequest({
          activity_scope: 'NIC',
          profile: 'subject',
          ...invalid
        })
      ).toThrow();
    }
  );
  it.each(['', 'rating_edit,HANDLE_EDIT'])(
    'accepts cleared and case-insensitive supported log types: %s',
    (log_type) => {
      expect(
        getNicActivityPageRequest({
          activity_scope: 'NIC',
          profile: 'subject',
          log_type
        })
      ).toEqual({ page: 1, page_size: 50 });
    }
  );
});
