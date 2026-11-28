import express, { RequestHandler, Router } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ApiAnswer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Answers GET paths through the real routers, mounted under /api as the
 * API mounts them. A rebuild test asks the same paths before and after and
 * compares the JSON. `omit` drops keys whose values another loop fills.
 */
export async function apiAnswers(
  mounts: readonly (readonly [string, Router | RequestHandler])[],
  paths: readonly string[],
  omit: readonly string[] = []
): Promise<Record<string, ApiAnswer>> {
  const app = express();
  app.disable('x-powered-by');
  for (const [path, handler] of mounts) {
    app.use(`/api${path}`, handler);
  }
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const { port } = server.address() as AddressInfo;
    const answers: Record<string, ApiAnswer> = {};
    for (const path of paths) {
      // A route that drops an error never answers; fail on it quickly.
      const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
        signal: AbortSignal.timeout(20_000)
      });
      const text = await response.text();
      answers[path] = {
        status: response.status,
        body: text
          ? JSON.parse(text, (key, value) =>
              omit.includes(key) ? undefined : value
            )
          : null
      };
    }
    return answers;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

/** Every answer was a success: a comparison of errors proves nothing. */
export function allOk(answers: Record<string, ApiAnswer>): string[] {
  return Object.entries(answers)
    .filter(([, answer]) => answer.status !== 200)
    .map(([path, answer]) => `${path}: ${answer.status}`);
}
