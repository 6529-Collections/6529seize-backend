// This must be require and not import because of how async-express-decorator works
const toAsyncRouter = require('async-express-decorator');
import { Router } from 'express';

export function asyncRouter(): Router {
  return toAsyncRouter(Router());
}
