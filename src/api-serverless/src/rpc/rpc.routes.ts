import { Request, Response } from 'express';
import { asyncRouter } from '../async.router';
import {
  GetNodeCommand,
  ManagedBlockchainClient
} from '@aws-sdk/client-managedblockchain';
import axios from 'axios';
import { Logger } from '../../../logging';

const router = asyncRouter();

const aws4 = require('aws4');

const logger = Logger.get('RPC_ROUTES');

router.get('/test', async (req: Request, res: Response) => {
  try {
    const managedBlockchainClient = new ManagedBlockchainClient({
      region: 'us-east-1'
    });
    const params = {
      NetworkId: 'n-ethereum-mainnet',
      NodeId: 'nd-ZPZ7IMF76BHW3CDJDKWWAGHQ4E'
    };
    const command = new GetNodeCommand(params);
    const nodeInfo = await managedBlockchainClient.send(command);
    res.json(nodeInfo);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.use('/:extraPath*?', async (req: Request, res: Response) => {
  let endpoint =
    'https://nd-zpz7imf76bhw3cdjdkwwaghq4e.ethereum.managedblockchain.us-east-1.amazonaws.com';

  if (req.params.extraPath) {
    endpoint += `/${req.params.extraPath}`;
  }

  const isBatch = Array.isArray(req.body);
  const requests: any = isBatch ? req.body : [req.body];

  const sendRequest = async (request: any) => {
    const body = JSON.stringify(request);
    const url = new URL(endpoint);

    const opts = {
      host: url.hostname,
      path: url.pathname + (url.search || ''),
      service: 'managedblockchain',
      region: 'us-east-1',
      method: 'POST',
      headers: {
        Host: url.hostname,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      body
    };

    aws4.sign(opts);

    try {
      const response = await axios({
        method: 'POST',
        url: endpoint,
        headers: opts.headers,
        data: body
      });
      return response.data;
    } catch (error: any) {
      logger.error(
        `Error processing RPC request: ${error.response?.data ?? error.message}`
      );
      return { error: error.response?.data ?? error.message, id: request.id };
    }
  };

  try {
    const results = await Promise.all(
      requests.map((req: any) => sendRequest(req))
    );
    res.status(200).json(isBatch ? results : results[0]);
  } catch (error: any) {
    logger.error(`Error processing RPC request: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
