import { Logger } from './logging';
import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { numbers, Numbers } from './numbers';

const SECRET = 'prod/lambdas';

const dotenv = require('dotenv');
const path = require('path');

const envs = ['local', 'development', 'production'];

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

  const secretsManager = new SecretsManager();

  const secret = await secretsManager.getSecretValue({ SecretId: SECRET });

  if (secret.SecretString) {
    const secretValue = JSON.parse(secret.SecretString);

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
