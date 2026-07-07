import type { Express, Request, Response } from 'express';

export function registerOpenApiSpecRoutes(
  app: Pick<Express, 'get'>,
  openApiYamlRaw: string,
  swaggerDocument: unknown
) {
  app.get('/openapi.yaml', (_req: Request, res: Response) => {
    res.type('application/yaml').send(openApiYamlRaw);
  });
  app.get('/openapi.json', (_req: Request, res: Response) => {
    res.json(swaggerDocument);
  });
}
