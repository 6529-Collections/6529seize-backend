import { notifyMissingNextgenMedia } from '../notifier';

const CF_BASE_PATH = 'https://media-proxy.nextgen-generator.seize.io';
const PLACEHOLDER_PATH = `${CF_BASE_PATH}/placeholders/pending.png`;

interface Details {
  network: string;
  tokenId?: number;
  collection?: number;
}

export const handler = async (event: any) => {
  const { request, response } = event.Records[0].cf;
  try {
    if (response.status === '403') {
      const uri = request.uri;
      const details = getDetails(uri);
      const image = getImagePath(details);
      await notifyMissingNextgenMedia(uri);
      const customResponse: any = {
        name: 'Pending...',
        description: 'Pending...',
        path: uri,
        network: details.network,
        image: image
      };
      if (details.collection) {
        customResponse.collection = details.collection;
      }
      if (details.tokenId) {
        customResponse.tokenId = details.tokenId;
      }
      response.body = JSON.stringify(customResponse);
      response.status = '200';
      response.statusDescription = 'OK';
      response.headers['content-type'] = [
        { key: 'Content-Type', value: 'application/json' }
      ];
    }
  } catch (e) {
    console.error(e);
    const customResponse: any = {
      name: 'Pending...',
      description: 'Pending...',
      path: request.uri,
      image: PLACEHOLDER_PATH
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

function getDetails(uri: string): Details {
  if (uri.startsWith('/')) {
    uri = uri.slice(1);
  }
  const uriSegments = uri.split('/');
  const network = uriSegments[0];
  const tokenIdStr = uri.split('/').pop();

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
  return PLACEHOLDER_PATH;
}
