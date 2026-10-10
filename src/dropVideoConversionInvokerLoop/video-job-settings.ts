import type {
  JobSettings,
  JobTemplateSettings,
  OutputGroup
} from '@aws-sdk/client-mediaconvert';

function withDestination(group: OutputGroup, destination: string): OutputGroup {
  const settings = group.OutputGroupSettings;
  if (settings?.Type === 'HLS_GROUP_SETTINGS') {
    return {
      ...group,
      OutputGroupSettings: {
        ...settings,
        HlsGroupSettings: {
          ...settings.HlsGroupSettings,
          Destination: `${destination}/hls/`
        }
      }
    };
  }
  if (settings?.Type === 'FILE_GROUP_SETTINGS') {
    return {
      ...group,
      OutputGroupSettings: {
        ...settings,
        FileGroupSettings: {
          ...settings.FileGroupSettings,
          Destination: `${destination}/mp4/`
        }
      }
    };
  }
  throw new Error(
    'Drop video template must contain only HLS and MP4 output groups'
  );
}

export function buildDropVideoJobSettings(
  template: JobTemplateSettings,
  bucket: string,
  key: string,
  generatePoster = true
): JobSettings {
  const groups = template.OutputGroups ?? [];
  const hlsGroups = groups.filter(
    (group) => group.OutputGroupSettings?.Type === 'HLS_GROUP_SETTINGS'
  );
  const mp4Groups = groups.filter(
    (group) => group.OutputGroupSettings?.Type === 'FILE_GROUP_SETTINGS'
  );
  if (groups.length !== 2 || hlsGroups.length !== 1 || mp4Groups.length !== 1) {
    throw new Error(
      'Drop video template must contain only HLS and MP4 output groups, exactly one of each'
    );
  }
  if (!hlsGroups[0].Outputs?.length || !mp4Groups[0].Outputs?.length) {
    throw new Error('Drop video template must define HLS and MP4 outputs');
  }
  const base = key.replace(/\.[^.]+$/i, '');
  const destination = `s3://${bucket}/renditions/${base}`;
  const input = template.Inputs?.[0];
  return {
    ...template,
    Inputs: [
      {
        ...input,
        FileInput: `s3://${bucket}/${key}`,
        VideoSelector: { ...input?.VideoSelector, Rotate: 'AUTO' }
      }
    ],
    OutputGroups: groups
      .map((group) => withDestination(group, destination))
      .concat(
        generatePoster
          ? [
              {
                Name: 'Chat poster',
                OutputGroupSettings: {
                  Type: 'FILE_GROUP_SETTINGS',
                  FileGroupSettings: { Destination: `${destination}/poster/` }
                },
                Outputs: [
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
                ]
              }
            ]
          : []
      )
  };
}
