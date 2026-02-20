import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';
import { env } from '../env';
import {
  CreateJobCommand,
  MediaConvertClient
} from '@aws-sdk/client-mediaconvert';

const logger = Logger.get('DROP_VIDEO_CONVERSION_INVOKER_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async (event) => {
  await doInDbContext(
    async () => {
      const endpoint = env.getStringOrThrow('MC_ENDPOINT');
      const roleArn = env.getStringOrThrow('MC_ROLE_ARN');
      const template = env.getStringOrThrow('MC_DROPS_VIDEO_TEMPLATE_NAME');
      const bucket = env.getStringOrThrow('S3_BUCKET');
      const bucketRegion = env.getStringOrThrow('BUCKET_REGION');
      const exts = ['mp4', 'mov', 'avi', 'webm'];
      const key = event.detail.object.key;
      if (key.includes('/hls/') || key.includes('/mp4/')) return;
      const ext = key.split('.').pop()!.toLowerCase();
      if (!exts.includes(ext)) return; // ignore pictures, etc.
      const base = key.replace(/\.[^.]+$/i, '');

      const mc = new MediaConvertClient({ region: bucketRegion, endpoint });
      const fileInput = `s3://${bucket}/${key}`;
      logger.info(`Invoking video conversion for ${fileInput}`);
      await mc.send(
        new CreateJobCommand({
          Role: roleArn,
          JobTemplate: template,
          Settings: {
            Inputs: [
              {
                FileInput: fileInput,
                VideoSelector: {
                  Rotate: 'AUTO'
                }
              }
            ],
            OutputGroups: [
              {
                OutputGroupSettings: {
                  Type: 'HLS_GROUP_SETTINGS',
                  HlsGroupSettings: {
                    Destination: `s3://${bucket}/renditions/${base}/hls/`
                  }
                }
              },
              {
                OutputGroupSettings: {
                  Type: 'FILE_GROUP_SETTINGS',
                  FileGroupSettings: {
                    Destination: `s3://${bucket}/renditions/${base}/mp4/`
                  }
                }
              }
            ]
          }
        })
      );
      logger.info(`Video conversion successfully invoked for ${fileInput}`);
    },
    { logger }
  );
});
