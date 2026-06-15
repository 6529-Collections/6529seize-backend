import { ApiDropPoll } from '@/api/generated/models/ApiDropPoll';
import { ApiDropPollOption } from '@/api/generated/models/ApiDropPollOption';
import { ApiWavePoll } from '@/api/generated/models/ApiWavePoll';
import { DropPollWithOptions } from '@/api/drops/drop-polls.db';
import { Time } from '@/time';

function mapOptions(poll: DropPollWithOptions): ApiDropPollOption[] {
  return [...poll.options]
    .sort((a, b) => a.option_no - b.option_no)
    .map((option) => ({
      option_no: option.option_no,
      option_string: option.option_string,
      votes: option.votes
    }));
}

export function mapDropPollToApi(
  poll: DropPollWithOptions,
  now = Time.currentMillis()
): ApiDropPoll {
  return {
    id: poll.id,
    options: mapOptions(poll),
    voted: [...(poll.voted ?? [])].sort((a, b) => a - b),
    multichoice: poll.multichoice,
    anonymous: poll.anonymous,
    only_droppers_can_respond: poll.only_droppers_can_respond ?? false,
    closing_time: poll.closing_time,
    is_open: now < poll.closing_time
  };
}

export function mapDropPollToApiWavePoll(
  poll: DropPollWithOptions,
  now = Time.currentMillis()
): ApiWavePoll {
  return {
    ...mapDropPollToApi(poll, now),
    wave_id: poll.wave_id,
    drop_id: poll.drop_id,
    created_at: poll.created_at ?? 0
  };
}
