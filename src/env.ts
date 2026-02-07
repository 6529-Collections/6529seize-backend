import { Logger } from './logging';
import {
  GetSecretValueCommandOutput,
  SecretsManager
} from '@aws-sdk/client-secrets-manager';
import { numbers, Numbers } from './numbers';
import { Time } from './time';

const SECRET = 'prod/lambdas';
const LOAD_SECRETS_MAX_ATTEMPTS = 5;
const LOAD_SECRETS_BASE_RETRY_DELAY_MS = 250;

const dotenv = require('dotenv');
const path = require('path');

const envs = ['local', 'development', 'production'];

function parseAwsTimestampOrNull(value: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) {
    return null;
  }
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  );
}

function extractClockSkewOffsetMsOrNull(errorMessage: string): number | null {
  const signedAtMatch = /Signature expired:\s*(\d{8}T\d{6}Z)/.exec(
    errorMessage
  );
  const serverTimeMatch = /\((\d{8}T\d{6}Z)\s*-\s*5 min\.\)/.exec(errorMessage);
  if (!signedAtMatch || !serverTimeMatch) {
    return null;
  }
  const signedAtMs = parseAwsTimestampOrNull(signedAtMatch[1]);
  const serverTimeMs = parseAwsTimestampOrNull(serverTimeMatch[1]);
  if (signedAtMs === null || serverTimeMs === null) {
    return null;
  }
  return serverTimeMs - signedAtMs;
}

function getErrorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    return String((error as { name?: unknown }).name ?? 'UNKNOWN');
  }
  return 'UNKNOWN';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? '');
  }
  return '';
}

export async function prepEnvironment() {
  if (!process.env.NODE_ENV) {
    await loadSecrets();
  } else {
    await loadLocalConfig();
  }
}

export async function loadSecrets() {
  const logger = Logger.get('SECRETS');
  logger.info('[LOADING SECRETS]');

  let clockOffsetMs = 0;
  let loadedSecret: GetSecretValueCommandOutput | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= LOAD_SECRETS_MAX_ATTEMPTS; attempt++) {
    const secretsManager = new SecretsManager({
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
      maxAttempts: 2,
      systemClockOffset: clockOffsetMs
    });

    try {
      loadedSecret = await secretsManager.getSecretValue({ SecretId: SECRET });
      break;
    } catch (error) {
      lastError = error;
      const errorMessage = getErrorMessage(error);
      const inferredClockOffsetMs =
        extractClockSkewOffsetMsOrNull(errorMessage);
      if (inferredClockOffsetMs !== null) {
        clockOffsetMs = inferredClockOffsetMs;
        logger.warn(
          `[SECRETS LOAD CLOCK SKEW ADJUSTMENT] [ATTEMPT ${attempt}] [OFFSET_MS ${clockOffsetMs}]`
        );
      }

      if (attempt === LOAD_SECRETS_MAX_ATTEMPTS) {
        break;
      }

      const jitterMs = Math.floor(Math.random() * 50);
      const retryDelayMs =
        LOAD_SECRETS_BASE_RETRY_DELAY_MS * 2 ** (attempt - 1) + jitterMs;
      logger.warn(
        `[SECRETS LOAD FAILED] [ATTEMPT ${attempt}/${LOAD_SECRETS_MAX_ATTEMPTS}] [ERROR_NAME ${getErrorName(
          error
        )}] [RETRY_IN_MS ${retryDelayMs}] [MESSAGE ${errorMessage}]`
      );
      await Time.millis(retryDelayMs).sleep();
    }
  }

  if (loadedSecret === null) {
    logger.error(
      `[SECRETS LOAD FAILED] [ATTEMPTS ${LOAD_SECRETS_MAX_ATTEMPTS}] [ERROR_NAME ${getErrorName(
        lastError
      )}] [MESSAGE ${getErrorMessage(lastError)}]`
    );
    throw lastError;
  }

  if (loadedSecret.SecretString) {
    const secretValue = JSON.parse(loadedSecret.SecretString);

    Object.keys(secretValue).forEach(function (key) {
      process.env[key] = secretValue[key];
    });
  }

  if (!process.env.NODE_ENV) {
    logger.info('[ENVIRONMENT]', `[NODE_ENV MISSING]`, '[EXITING]');
    process.exit();
  }

  if (!envs.includes(process.env.NODE_ENV)) {
    logger.info(
      '[ENVIRONMENT]',
      `[INVALID ENV '${process.env.NODE_ENV}']`,
      '[EXITING]'
    );
    process.exit();
  }

  logger.info('[SECRETS LOADED]');
}

export async function loadLocalConfig() {
  const logger = Logger.get('ENV_READER');
  if (process.env.NODE_ENV) {
    const envPath = path.join(__dirname, '..', `.env.${process.env.NODE_ENV}`);
    logger.info(`[LOADING LOCAL CONFIG FROM ${envPath}]`);
    dotenv.config({
      path: envPath
    });
  }
}

export class Env {
  constructor(private readonly numbers: Numbers) {}

  public getStringOrNull(name: string): string | null {
    return process.env[name] ?? null;
  }

  public getStringOrThrow(name: string): string {
    const value = this.getStringOrNull(name);
    if (!value) {
      throw new Error(`Expected environment variable ${name} not configured`);
    }
    return value;
  }

  public getIntOrThrow(name: string): number {
    const strValue = this.getStringOrThrow(name);
    const intValue = this.numbers.parseIntOrNull(strValue);
    if (intValue === null) {
      throw new Error(`Expected environment variable ${name} to be an integer`);
    }
    return intValue;
  }

  public getIntOrNull(name: string): number | null {
    const strValue = this.getStringOrNull(name);
    if (strValue === null) {
      return null;
    }
    return this.numbers.parseIntOrNull(strValue);
  }

  public getStringArray(name: string, delimiter?: string): string[] {
    delimiter = delimiter || ';';
    const strValue = this.getStringOrNull(name);
    if (strValue === null) {
      return [];
    }
    return strValue.split(delimiter);
  }
}

export const env = new Env(numbers);
