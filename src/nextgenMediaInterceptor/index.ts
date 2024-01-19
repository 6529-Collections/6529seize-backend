import { notifyMissingNextgenMedia } from '../notifier';

const CF_BASE_PATH = 'https://media-proxy.nextgen-generator.seize.io';
const DEFAULT_IMAGE_PATH = `${CF_BASE_PATH}/placeholders/pending.png`;

const DEFAULT_RESPONSE_BODY = {
  name: 'Pending...',
  description: 'Pending...',
  image: DEFAULT_IMAGE_PATH
};

interface Details {
  network: string;
  tokenId?: number;
  collection?: number;
}

export const handler = async (event: any) => {
  let { request, response } = event.Records[0].cf;
  try {
    if (response.status === '403') {
      const uri = request.uri;
      await notifyMissingNextgenMedia(uri);

      const details = getDetails(uri);
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
    console.error(e);
    const customBody: any = DEFAULT_RESPONSE_BODY;
    customBody.path = request.uri;
    response = buildJsonResponse(response, customBody);
  }
  return response;
};

function getDetails(uri: string): Details {
  if (uri.startsWith('/')) {
    uri = uri.slice(1);
  }
  const uriSegments = uri.split('/');
  const network = uriSegments[0];
  const tokenIdStr = uriSegments.pop();

  const tokenId = Number(tokenIdStr);
  if (!isNaN(tokenId)) {
    const collection = Math.round(tokenId / 10000000000);
    return {
      network: network,
      tokenId: tokenId,
      collection: collection
    };
  }
  return {
    network: network
  };
}

function getImagePath(details: Details) {
  if (details.collection && details.collection > 0) {
    return `${CF_BASE_PATH}/placeholders/${details.network}/${details.collection}.png`;
  }
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
