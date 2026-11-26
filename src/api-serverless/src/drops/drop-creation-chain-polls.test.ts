import { DropCreationApiService } from '@/api/drops/drop-creation.api.service';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { Time } from '@/time';
import { WavesPollsPausedException } from '@/waves-freeze/waves-chain-polls';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';

const NAMES = [
  'FEATURE_WAVES_FROZEN',
  'WAVES_FREEZE_AT',
  'FEATURE_WAVES_ON_CHAIN',
  'WAVES_SWITCH_ON_AT',
  'FEATURE_WAVES_CHAIN_POLLS'
];
const SWITCH_ON = Date.UTC(2026, 10, 28);
const PAST_GUARD = new Error('past the poll guard');

function create(request: Record<string, unknown>) {
  const createOrUpdateDrop = {
    preResolveIdentityNomination: jest.fn().mockRejectedValue(PAST_GUARD)
  };
  const dropsMappers = {
    createDropApiToUseCaseModel: jest.fn(({ request }) => ({
      drop_type: request.drop_type,
      wave_id: request.wave_id,
      parts: []
    }))
  };
  const service = new DropCreationApiService(
    {} as never,
    {} as never,
    dropsMappers as never,
    createOrUpdateDrop as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
  return {
    createOrUpdateDrop,
    result: service.createDrop(
      {
        createDropRequest: { parts: [], ...request } as any,
        authorId: 'author',
        representativeId: 'author'
      },
      {}
    )
  };
}

describe('new drops with a poll from the switch-on', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of NAMES) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of NAMES) delete process.env[name];
    process.env.WAVES_SWITCH_ON_AT = new Date(SWITCH_ON).toISOString();
    jest.spyOn(Time, 'currentMillis').mockReturnValue(SWITCH_ON + 1);
    stubWavesScope({ staying: ['staying-wave'] });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => {
    for (const name of NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  const poll = { options: ['a', 'b'] };

  it('refuses a poll in a moved wave before any moderation work', async () => {
    const { result, createOrUpdateDrop } = create({
      drop_type: ApiDropType.Chat,
      wave_id: 'moved-wave',
      poll
    });
    await expect(result).rejects.toBeInstanceOf(WavesPollsPausedException);
    expect(
      createOrUpdateDrop.preResolveIdentityNomination
    ).not.toHaveBeenCalled();
  });

  it('takes the poll with the setting on, or in a staying wave', async () => {
    await expect(
      create({ drop_type: ApiDropType.Chat, wave_id: 'staying-wave', poll })
        .result
    ).rejects.toBe(PAST_GUARD);
    process.env.FEATURE_WAVES_CHAIN_POLLS = 'true';
    await expect(
      create({ drop_type: ApiDropType.Chat, wave_id: 'moved-wave', poll })
        .result
    ).rejects.toBe(PAST_GUARD);
  });

  it('posts chat without a poll as before', async () => {
    await expect(
      create({ drop_type: ApiDropType.Chat, wave_id: 'moved-wave', poll: null })
        .result
    ).rejects.toBe(PAST_GUARD);
  });
});
