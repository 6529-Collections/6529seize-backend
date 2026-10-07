import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { env, prepEnvironment } from '../env';
import { Time } from '../time';
import {
  CreateJobCommand,
  GetJobTemplateCommand,
  MediaConvertClient
} from '@aws-sdk/client-mediaconvert';
import { buildDropVideoJobSettings } from './video-job-settings';

const logger = Logger.get('DROP_VIDEO_CONVERSION_INVOKER_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async (event) => {
  const start = Time.now();
  logger.info(`[RUNNING]`);
  try {
    await prepEnvironment();
    const endpoint = env.getStringOrThrow('MC_ENDPOINT');
    const roleArn = env.getStringOrThrow('MC_ROLE_ARN');
    const template = env.getStringOrThrow('MC_DROPS_VIDEO_TEMPLATE_NAME');
    const bucket = env.getStringOrThrow('S3_BUCKET');
    const bucketRegion = env.getStringOrThrow('BUCKET_REGION');
    const exts = ['mp4', 'mov', 'avi', 'webm'];
    const key = event.detail.object.key;
    if (
      !key.startsWith('drops/') ||
      key.includes('/hls/') ||
      key.includes('/mp4/')
    )
      return;
    const ext = key.split('.').pop()!.toLowerCase();
    if (!exts.includes(ext)) return; // ignore pictures, etc.

    const mc = new MediaConvertClient({ region: bucketRegion, endpoint });
    const fileInput = `s3://${bucket}/${key}`;
    // Expand the template before adding an output: do not rely on merging
    // differently sized OutputGroups arrays or replace its video/audio codecs.
    const { JobTemplate: jobTemplate } = await mc.send(
      new GetJobTemplateCommand({ Name: template })
    );
    if (!jobTemplate?.Settings) {
      throw new Error(`Drop video template ${template} has no settings`);
    }
    logger.info(`Invoking video conversion for ${fileInput}`);
    await mc.send(
      new CreateJobCommand({
        Role: roleArn,
        JobTemplate: template,
        Settings: buildDropVideoJobSettings(jobTemplate.Settings, bucket, key)
      })
    );
    logger.info(`Video conversion successfully invoked for ${fileInput}`);
  } finally {
    logger.info(`[FINISHED IN ${start.diffFromNow().formatAsDuration()}]`);
  }
});
