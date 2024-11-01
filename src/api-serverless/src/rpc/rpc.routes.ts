import { Response } from 'express';
import { Request } from 'express';
import { asyncRouter } from '../async.router';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { ClientRequest, IncomingMessage } from 'http';
import {
  GetNodeCommand,
  ManagedBlockchainClient
} from '@aws-sdk/client-managedblockchain';

const router = asyncRouter();

const aws4 = require('aws4');
const https = require('https');

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

router.use(
  '/',
  createProxyMiddleware({
    target:
      'https://nd-zpz7imf76bhw3cdjdkwwaghq4e.ethereum.managedblockchain.us-east-1.amazonaws.com',
    changeOrigin: true,
    pathRewrite: { '^/rpc': '' },
    selfHandleResponse: true,
    on: {
      proxyReq: async (
        proxyReq: ClientRequest,
        req: Request,
        res: Response
      ) => {
        const requestBodies = Array.isArray(req.body) ? req.body : [req.body];
        const isBatchRequest = Array.isArray(req.body);

        if (
          requestBodies.length === 0 ||
          Object.keys(requestBodies[0]).length === 0
        ) {
          res.status(200).json({});
          return;
        }

        const responses = [];

        for (const individualRequest of requestBodies) {
          const individualBody = JSON.stringify(individualRequest);
          const opts = {
            host: proxyReq.getHeader('host') as string,
            path: proxyReq.path,
            service: 'managedblockchain',
            region: 'us-east-1',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(individualBody)
            },
            body: individualBody
          };
          aws4.sign(opts);

          const response = await new Promise((resolve, reject) => {
            const individualReq = https.request(
              opts,
              (individualRes: IncomingMessage) => {
                let data = '';
                individualRes.on('data', (chunk: any) => (data += chunk));
                individualRes.on('end', () => resolve(JSON.parse(data)));
              }
            );
            individualReq.on('error', reject);
            individualReq.write(individualBody);
            individualReq.end();
          });

          responses.push(response);
        }

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(200).json(isBatchRequest ? responses : responses[0]);
      },
      proxyRes: (proxyRes: IncomingMessage, req: Request, res: Response) => {
        let responseBody = '';

        proxyRes.on('data', (chunk) => {
          responseBody += chunk;
        });

        proxyRes.on('end', () => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = proxyRes.statusCode!;
          res.end(responseBody);
        });
      },
      error: (err: any, req: any, res: any) => {
        res.writeHead(500, {
          'Content-Type': 'text/plain'
        });
        res.end('Something went wrong with the RPC proxy.');
      }
    }
  })
);

export default router;
