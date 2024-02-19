import { Logger } from '../logging';
import { NEXTGEN_CF_BASE_PATH } from '../nextgen/nextgen_constants';
import { Details, getGenDetailsFromUri } from '../nextgen/nextgen_generator';

const logger = Logger.get('NEXTGEN_MEDIA_INTERCEPTOR');

const DEFAULT_IMAGE_PATH = `${NEXTGEN_CF_BASE_PATH}/placeholders/pending.png`;

const DEFAULT_RESPONSE_BODY = {
  name: 'Pending...',
  description: 'Pending...'
};

export const handler = async (event: any) => {
  const cf = event.Records[0].cf;
  const request = cf.request;
  let response = cf.response;
  try {
    if (response.status === '403') {
      const uri = request.uri;

      const details = getGenDetailsFromUri(uri);
      const image = getImagePath(details);
      const customResponse: any = DEFAULT_RESPONSE_BODY;
      customResponse.path = uri;
      customResponse.network = details.network;
      customResponse.image = image;
      if (details.collection) {
        customResponse.collection = details.collection;
      } else {
        delete customResponse.collection;
      }
      if (details.tokenId) {
        customResponse.tokenId = details.tokenId;
      } else {
        delete customResponse.tokenId;
      }
      response = buildJsonResponse(response, customResponse);
    }
  } catch (e) {
    logger.error(`[ERROR] : [${e}]`);
    const customBody: any = DEFAULT_RESPONSE_BODY;
    customBody.path = request.uri;
    customBody.image = DEFAULT_IMAGE_PATH;
    response = buildJsonResponse(response, customBody);
  }
  return response;
};

function getImagePath(details: Details) {
  if (details.collection && details.collection > 0) {
    return `${NEXTGEN_CF_BASE_PATH}/placeholders/${details.network}/${details.collection}.png`;
  }
  logger.info(`[DETAILS ERROR] : [${details}]`);
  return DEFAULT_IMAGE_PATH;
}

function buildJsonResponse(response: any, body: any) {
  response.body = JSON.stringify(body);
  response.status = '200';
  response.statusDescription = 'OK';
  response.headers['content-type'] = [
    { key: 'Content-Type', value: 'application/json' }
  ];
  response.headers['cache-control'] = [
    { key: 'Cache-Control', value: 'no-store' }
  ];
  return response;
}
