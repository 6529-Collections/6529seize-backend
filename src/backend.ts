import * as path from 'path';
import * as dbMigrationsLoop from './dbMigrationsLoop';
import { Logger } from './logging';

const logger = Logger.get('BACKEND');

type LambdaHandler = (
  event: unknown,
  context: unknown,
  callback: unknown
) => Promise<unknown> | unknown;

function getRequestedLoopName(): string | undefined {
  const loopName = process.argv[2];
  if (!loopName) {
    return undefined;
  }

  if (!/^[A-Za-z0-9_-]+$/.test(loopName)) {
    throw new Error(`[INVALID LOOP NAME] [${loopName}]`);
  }

  return loopName;
}

function resolveRequestedLoopPath(loopName: string): string | null {
  const loopModulePath = path.join(__dirname, loopName, 'index');
  try {
    return require.resolve(loopModulePath);
  } catch {
    return null;
  }
}

async function runRequestedLoopIfPresent() {
  const loopName = getRequestedLoopName();
  if (!loopName) {
    return;
  }

  const loopModulePath = resolveRequestedLoopPath(loopName);
  if (!loopModulePath) {
    throw new Error(
      `[REQUESTED LOOP NOT FOUND] [${loopName}] [EXPECTED ${path.join(
        __dirname,
        loopName,
        'index'
      )}]`
    );
  }

  const loopModule = require(loopModulePath) as {
    handler?: LambdaHandler;
  };

  if (typeof loopModule.handler !== 'function') {
    throw new Error(`[REQUESTED LOOP HAS NO HANDLER] [${loopName}]`);
  }

  logger.info(`[EXECUTING REQUESTED LOOP] [${loopName}]`);
  await loopModule.handler(null, null, null);
}

async function start() {
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await dbMigrationsLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );

  await runRequestedLoopIfPresent();

  process.exit(0);
}

start();
