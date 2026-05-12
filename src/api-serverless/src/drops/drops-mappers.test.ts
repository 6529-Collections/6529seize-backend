import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { resolveApiDropPriorityMetadata } from '@/api/drops/drops.mappers';

describe('resolveApiDropPriorityMetadata', () => {
  const additionalMedia = {
    data_key: 'additional_media',
    data_value: '{"preview_image":"https://example.com/image.png"}',
    resolved_profile: null
  };

  it('returns additional media metadata for main stage submission drops', () => {
    const result = resolveApiDropPriorityMetadata({
      dropType: ApiDropType.Participatory,
      waveId: 'main-stage-wave',
      mainStageWaveId: 'main-stage-wave',
      metadata: [
        { data_key: 'artist', data_value: 'Artist', resolved_profile: null },
        additionalMedia
      ]
    });

    expect(result).toEqual([additionalMedia]);
  });

  it('leaves priority metadata undefined for non-main-stage drops', () => {
    const result = resolveApiDropPriorityMetadata({
      dropType: ApiDropType.Participatory,
      waveId: 'other-wave',
      mainStageWaveId: 'main-stage-wave',
      metadata: [additionalMedia]
    });

    expect(result).toBeUndefined();
  });

  it('leaves priority metadata undefined when additional media is missing', () => {
    const result = resolveApiDropPriorityMetadata({
      dropType: ApiDropType.Participatory,
      waveId: 'main-stage-wave',
      mainStageWaveId: 'main-stage-wave',
      metadata: [
        { data_key: 'artist', data_value: 'Artist', resolved_profile: null }
      ]
    });

    expect(result).toBeUndefined();
  });

  it('leaves priority metadata undefined for main stage chat drops', () => {
    const result = resolveApiDropPriorityMetadata({
      dropType: ApiDropType.Chat,
      waveId: 'main-stage-wave',
      mainStageWaveId: 'main-stage-wave',
      metadata: [additionalMedia]
    });

    expect(result).toBeUndefined();
  });
});
