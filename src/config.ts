import dotenv from 'dotenv';
import path from 'path';

const envs = ['local', 'development', 'production'];

if (!process.env.NODE_ENV) {
  console.log(new Date(), '[ENVIRONMENT]', `[NODE_ENV MISSING`, '[EXITING]');
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

dotenv.config({
  path: path.join(__dirname, '..', `.env.${process.env.NODE_ENV}`)
});

export const db = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_HOST,
  DB_USER: process.env.DB_USER,
  DB_PASS: process.env.DB_PASS,
  DB_NAME: process.env.DB_NAME
};

export const aws = {
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_IMAGES_BUCKET_NAME: process.env.AWS_IMAGES_BUCKET_NAME
};

export const opensea = {
  OPENSEA_API_KEY: process.env.OPENSEA_API_KEY
};

export const alchemy = {
  ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY
};
