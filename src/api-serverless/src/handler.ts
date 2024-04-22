import { app } from './app';

const serverlessHttp = require('serverless-http');
export const handler = serverlessHttp(app);
