import type { JobTemplateSettings } from '@aws-sdk/client-mediaconvert';
import { buildDropVideoJobSettings } from './video-job-settings';

function template(): JobTemplateSettings {
  return {
    TimecodeConfig: { Source: 'ZEROBASED' },
    Inputs: [
      {
        AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } }
      }
    ],
    OutputGroups: [
      {
        OutputGroupSettings: {
          Type: 'HLS_GROUP_SETTINGS',
          HlsGroupSettings: { SegmentLength: 6, Destination: 'old/hls/' }
        },
        Outputs: [
          {
            NameModifier: '_360p',
            VideoDescription: { CodecSettings: { Codec: 'H_264' } }
          }
        ]
      },
      {
        OutputGroupSettings: {
          Type: 'FILE_GROUP_SETTINGS',
          FileGroupSettings: { Destination: 'old/mp4/' }
        },
        Outputs: [
          {
            NameModifier: '_720p',
            ContainerSettings: { Container: 'MP4' },
            AudioDescriptions: [{ CodecSettings: { Codec: 'AAC' } }]
          }
        ]
      }
    ]
  };
}

it('preserves HLS and MP4 encodes while omitting frame capture for a device poster', () => {
  const source = template();
  const withPoster = buildDropVideoJobSettings(
    source,
    'bucket',
    'drops/clip.mp4'
  );
  const withoutPoster = buildDropVideoJobSettings(
    source,
    'bucket',
    'drops/clip.mp4',
    false
  );
  expect(withoutPoster.OutputGroups).toEqual(
    withPoster.OutputGroups?.slice(0, 2)
  );
  expect(withoutPoster.Inputs).toEqual(withPoster.Inputs);
});

it.each(['mp4', 'MOV', 'webm', 'avi'])(
  'preserves video encodes and adds bounded first and one-second previews for %s',
  (extension) => {
    const source = template();
    const before = JSON.stringify(source);
    const job = buildDropVideoJobSettings(
      source,
      'bucket',
      `drops/author/clip.part.${extension}`
    );
    expect(JSON.stringify(source)).toBe(before);
    expect(job.TimecodeConfig).toEqual(source.TimecodeConfig);
    expect(job.Inputs?.[0]).toEqual({
      ...source.Inputs?.[0],
      FileInput: `s3://bucket/drops/author/clip.part.${extension}`,
      VideoSelector: { Rotate: 'AUTO' }
    });
    const groups = job.OutputGroups!;
    expect(groups).toHaveLength(3);
    expect(groups[0].Outputs).toEqual(source.OutputGroups?.[0].Outputs);
    expect(groups[1].Outputs).toEqual(source.OutputGroups?.[1].Outputs);
    expect(groups[0].OutputGroupSettings?.HlsGroupSettings).toEqual({
      SegmentLength: 6,
      Destination: 's3://bucket/renditions/drops/author/clip.part/hls/'
    });
    expect(groups[1].OutputGroupSettings?.FileGroupSettings?.Destination).toBe(
      's3://bucket/renditions/drops/author/clip.part/mp4/'
    );
    const poster = groups[2];
    expect(poster.OutputGroupSettings?.FileGroupSettings?.Destination).toBe(
      's3://bucket/renditions/drops/author/clip.part/poster/'
    );
    expect(poster.Outputs).toEqual([
      {
        NameModifier: '_poster',
        ContainerSettings: { Container: 'RAW' },
        VideoDescription: {
          Width: 640,
          Height: 640,
          ScalingBehavior: 'FIT_NO_UPSCALE',
          CodecSettings: {
            Codec: 'FRAME_CAPTURE',
            FrameCaptureSettings: {
              FramerateNumerator: 1,
              FramerateDenominator: 1,
              MaxCaptures: 2,
              Quality: 80
            }
          }
        }
      }
    ]);
  }
);

// docs/chat-video-previews.md and frontend #4178 share this storage contract.
// MediaConvert numbers the first frame 0000000 and the one-second frame 0000001.
// Sub-second inputs can emit only 0000000; the frontend must retain that fallback.
it('guards the two-capture settings used for preferred and fallback posters', () => {
  const job = buildDropVideoJobSettings(
    template(),
    'bucket',
    'drops/video.mp4'
  );
  const output = job.OutputGroups?.find((group) => group.Name === 'Chat poster')
    ?.Outputs?.[0];
  expect(output?.NameModifier).toBe('_poster');
  expect(output?.VideoDescription?.CodecSettings).toMatchObject({
    Codec: 'FRAME_CAPTURE',
    FrameCaptureSettings: {
      FramerateNumerator: 1,
      FramerateDenominator: 1,
      MaxCaptures: 2
    }
  });
});

it('rejects templates that would remove playable video outputs', () => {
  expect(() =>
    buildDropVideoJobSettings({}, 'bucket', 'drops/video.mp4')
  ).toThrow('HLS and MP4');
  const noMp4 = template();
  noMp4.OutputGroups?.pop();
  expect(() =>
    buildDropVideoJobSettings(noMp4, 'bucket', 'drops/video.mp4')
  ).toThrow('HLS and MP4');
});

it('rejects unknown output groups rather than writing to their old destination', () => {
  const source = template();
  source.OutputGroups?.push({
    OutputGroupSettings: { Type: 'DASH_ISO_GROUP_SETTINGS' },
    Outputs: [{}]
  });
  expect(() =>
    buildDropVideoJobSettings(source, 'bucket', 'drops/video.mp4')
  ).toThrow('only HLS and MP4');
});

it.each([0, 1])(
  'rejects duplicate output group %s before destinations can collide',
  (index) => {
    const source = template();
    source.OutputGroups?.push(source.OutputGroups[index]);
    expect(() =>
      buildDropVideoJobSettings(source, 'bucket', 'drops/video.mp4')
    ).toThrow('exactly one of each');
  }
);

it.each([0, 1])('rejects an empty required output group %s', (index) => {
  const source = template();
  source.OutputGroups![index].Outputs = [];
  expect(() =>
    buildDropVideoJobSettings(source, 'bucket', 'drops/video.mp4')
  ).toThrow('HLS and MP4 outputs');
});

it.each([undefined, []])(
  'handles missing input settings without inventing selectors (%s)',
  (inputs) => {
    const source = template();
    source.Inputs = inputs;
    expect(
      buildDropVideoJobSettings(source, 'bucket', 'drops/video.mp4').Inputs
    ).toEqual([
      {
        FileInput: 's3://bucket/drops/video.mp4',
        VideoSelector: { Rotate: 'AUTO' }
      }
    ]);
  }
);

it('preserves video selectors while applying automatic rotation', () => {
  const source = template();
  source.Inputs![0].VideoSelector = {
    Rotate: 'DEGREES_90',
    ColorSpace: 'REC_709'
  };
  expect(
    buildDropVideoJobSettings(source, 'bucket', 'drops/video.mp4').Inputs?.[0]
      .VideoSelector
  ).toEqual({ Rotate: 'AUTO', ColorSpace: 'REC_709' });
});
