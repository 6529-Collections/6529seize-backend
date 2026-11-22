import { DropCreationApiService } from '@/api/drops/drop-creation.api.service';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { WavesFrozenException } from '@/waves-freeze/waves-freeze';

const NAMES = [
  'FEATURE_WAVES_FROZEN',
  'FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE',
  'WAVES_FREEZE_AT',
  'MAIN_STAGE_WAVE_ID'
];
const PAST_FREEZE = new Error('past the waves freeze check');

function createService() {
  const createOrUpdateDrop = {
    preResolveIdentityNomination: jest.fn().mockRejectedValue(PAST_FREEZE)
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
  return { service, createOrUpdateDrop };
}

function create(request: Record<string, unknown>) {
  return createService().service.createDrop(
    {
      createDropRequest: { parts: [], ...request } as any,
      authorId: 'author',
      representativeId: 'author'
    },
    {}
  );
}

describe('new drops during the waves freeze', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of NAMES) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of NAMES) delete process.env[name];
    process.env.FEATURE_WAVES_FROZEN = 'true';
    process.env.MAIN_STAGE_WAVE_ID = 'main';
  });
  afterAll(() => {
    for (const name of NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  it('refuses a poll before any moderation work', async () => {
    await expect(
      create({
        drop_type: ApiDropType.Chat,
        wave_id: 'wave',
        poll: { options: ['a', 'b'] }
      })
    ).rejects.toBeInstanceOf(WavesFrozenException);
  });

  it('refuses a legacy entry, except to the Main Stage when kept', async () => {
    await expect(
      create({ drop_type: ApiDropType.Participatory, wave_id: 'main' })
    ).rejects.toBeInstanceOf(WavesFrozenException);
    process.env.FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE = 'true';
    await expect(
      create({ drop_type: ApiDropType.Participatory, wave_id: 'main' })
    ).rejects.toBe(PAST_FREEZE);
    await expect(
      create({ drop_type: ApiDropType.Participatory, wave_id: 'wave' })
    ).rejects.toBeInstanceOf(WavesFrozenException);
  });

  it('posts chat as before', async () => {
    await expect(
      create({ drop_type: ApiDropType.Chat, wave_id: 'wave', poll: null })
    ).rejects.toBe(PAST_FREEZE);
  });
});
