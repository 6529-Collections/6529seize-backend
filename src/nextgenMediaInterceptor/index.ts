import { notifyMissingNextgenMedia } from '../notifier';

export const handler = async (event: any) => {
  const request = event.Records[0].cf.request;
  const response = event.Records[0].cf.response;
  if (response.status === '403') {
    await notifyMissingNextgenMedia(request.uri);
  }
  return response;
};
