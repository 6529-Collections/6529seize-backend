import { app } from './app';
import * as sentryContext from '../../sentry.context';

const serverlessHttp = require('serverless-http');

export const handler = sentryContext.wrapLambdaHandler(serverlessHttp(app));
