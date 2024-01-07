import { notifyMissingNextgenMedia } from '../notifier';

export const handler = async (event: any) => {
  const request = event.Records[0].cf.request;
  const response = event.Records[0].cf.response;
  if (response.status === '403') {
    await notifyMissingNextgenMedia(request.uri);
    const customResponse = {
      name: 'Pending...',
      description: 'Pending...',
      path: request.uri,
      image:
        'https://media-proxy.nextgen-generator.seize.io/nextgen-placeholder.png'
    };
    response.body = JSON.stringify(customResponse);
    response.status = '200';
    response.statusDescription = 'OK';
    response.headers['content-type'] = [
      { key: 'Content-Type', value: 'application/json' }
    ];
  }
  return response;
};
