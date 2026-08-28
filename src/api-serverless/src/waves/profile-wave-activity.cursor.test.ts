import { BadRequestException } from '@/exceptions';
import { ProfileWaveActivityCursorCodec } from './profile-wave-activity.cursor';

function encodePayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('ProfileWaveActivityCursorCodec', () => {
  const codec = new ProfileWaveActivityCursorCodec();

  it('round-trips CREATED cursors', () => {
    const cursor = {
      hasQualifyingPost: 1,
      latestPostTimestamp: 1_725_000_000_000,
      waveSerialNo: 42,
      waveId: 'wave-created'
    };

    expect(
      codec.decodeCreated(codec.encodeCreated('profile-1', cursor), 'profile-1')
    ).toEqual(cursor);
  });

  it('round-trips RECENT cursors', () => {
    const cursor = {
      latestPostTimestamp: 1_725_000_000_000,
      waveId: 'wave-recent'
    };

    expect(
      codec.decodeRecent(codec.encodeRecent('profile-1', cursor), 'profile-1')
    ).toEqual(cursor);
  });

  it('rejects malformed and structurally tampered payloads', () => {
    expect(() => codec.decodeCreated('not+base64url', 'profile-1')).toThrow(
      BadRequestException
    );
    expect(() =>
      codec.decodeCreated(
        encodePayload({
          v: 1,
          activity_type: 'CREATED',
          target_profile_id: 'profile-1',
          sort: 'tampered'
        }),
        'profile-1'
      )
    ).toThrow(BadRequestException);
  });

  it('binds cursors to the activity type and target profile', () => {
    const cursor = codec.encodeCreated('profile-1', {
      hasQualifyingPost: 1,
      latestPostTimestamp: 100,
      waveSerialNo: 5,
      waveId: 'wave-1'
    });

    expect(() => codec.decodeCreated(cursor, 'profile-2')).toThrow(
      BadRequestException
    );
    expect(() => codec.decodeRecent(cursor, 'profile-1')).toThrow(
      BadRequestException
    );
  });

  it('rejects CREATED cursors whose post flag and timestamp disagree', () => {
    const cursor = encodePayload({
      v: 1,
      activity_type: 'CREATED',
      target_profile_id: 'profile-1',
      sort: {
        has_qualifying_post: 0,
        latest_post_timestamp: 100,
        wave_serial_no: 5,
        wave_id: 'wave-1'
      }
    });

    expect(() => codec.decodeCreated(cursor, 'profile-1')).toThrow(
      BadRequestException
    );
  });
});
