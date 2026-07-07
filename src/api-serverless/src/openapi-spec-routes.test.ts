import express from 'express';
import { Server } from 'node:http';
import { registerOpenApiSpecRoutes } from './openapi-spec-routes';

function createTestApp() {
  const app = express();
  registerOpenApiSpecRoutes(
    app,
    'openapi: 3.0.3\ninfo:\n  title: 6529.io API\n',
    {
      openapi: '3.0.3',
      info: {
        title: '6529.io API'
      }
    }
  );
  return app;
}

async function withServer<T>(
  callback: (baseUrl: string) => Promise<T>
): Promise<T> {
  const app = createTestApp();
  const server = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected test server to listen on a TCP port');
    }

    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

describe('openapi spec routes', () => {
  it('serves the raw YAML OpenAPI spec', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/openapi.yaml`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'application/yaml'
      );
      await expect(response.text()).resolves.toBe(
        'openapi: 3.0.3\ninfo:\n  title: 6529.io API\n'
      );
    });
  });

  it('serves the parsed JSON OpenAPI spec', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/openapi.json`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'application/json'
      );
      await expect(response.json()).resolves.toEqual({
        openapi: '3.0.3',
        info: {
          title: '6529.io API'
        }
      });
    });
  });
});
