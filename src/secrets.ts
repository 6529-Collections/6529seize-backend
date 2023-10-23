import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { connect, disconnect } from './db';

const envs = ['local', 'development', 'production'];

const SECRET = 'prod/lambdas';

const dotenv = require('dotenv');
const path = require('path');

export async function loadEnv(entities: any[] = []) {
  if (!process.env.NODE_ENV) {
    await loadSecrets();
  } else {
    await loadLocalConfig();
  }

  await connect(entities);
}

export async function unload() {
  // await disconnect();
}

export async function loadSecrets() {
  console.log(new Date(), '[LOADING SECRETS]');

  const secretsManager = new SecretsManager({ region: 'us-east-1' });

  const secret = await secretsManager.getSecretValue({ SecretId: SECRET });

  if (secret.SecretString) {
    const secretValue = JSON.parse(secret.SecretString);

    Object.keys(secretValue).forEach(function (key) {
      process.env[key] = secretValue[key];
    });
  }

  if (!process.env.NODE_ENV) {
    console.log(new Date(), '[ENVIRONMENT]', `[NODE_ENV MISSING]`, '[EXITING]');
    process.exit();
  }

  if (!envs.includes(process.env.NODE_ENV)) {
    console.log(
      new Date(),
      '[ENVIRONMENT]',
      `[INVALID ENV '${process.env.NODE_ENV}']`,
      '[EXITING]'
    );
    process.exit();
  }

  console.log(new Date(), '[SECRETS LOADED]');
}

export async function loadLocalConfig() {
  if (process.env.NODE_ENV) {
    const envPath = path.join(__dirname, '..', `.env.${process.env.NODE_ENV}`);
    console.log(`[LOADING LOCAL CONFIG FROM ${envPath}]`);
    dotenv.config({
      path: envPath
    });
  }
}
