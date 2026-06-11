import {
  mapDropPollToApi,
  mapDropPollToApiWavePoll
} from '@/api/drops/drop-polls.mappers';

describe('drop poll mappers', () => {
  const poll = {
    id: 'poll-1',
    wave_id: 'wave-1',
    drop_id: 'drop-1',
    closing_time: 2_000,
    multichoice: true,
    anonymous: true,
    created_at: 1_000,
    voted: [2, 1],
    options: [
      {
        poll_id: 'poll-1',
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        option_no: 2,
        option_string: 'Second',
        votes: 3,
        voted_by_context_profile: true
      },
      {
        poll_id: 'poll-1',
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        option_no: 1,
        option_string: 'First',
        votes: 5,
        voted_by_context_profile: true
      }
    ]
  };

  it('maps anonymous poll metadata and viewer vote selections', () => {
    expect(mapDropPollToApi(poll, 1_500)).toEqual({
      id: 'poll-1',
      options: [
        { option_no: 1, option_string: 'First', votes: 5 },
        { option_no: 2, option_string: 'Second', votes: 3 }
      ],
      voted: [1, 2],
      multichoice: true,
      anonymous: true,
      closing_time: 2_000,
      is_open: true
    });
  });

  it('maps anonymous metadata for wave poll responses', () => {
    expect(mapDropPollToApiWavePoll(poll, 2_500)).toMatchObject({
      id: 'poll-1',
      wave_id: 'wave-1',
      drop_id: 'drop-1',
      created_at: 1_000,
      anonymous: true,
      is_open: false
    });
  });
});
