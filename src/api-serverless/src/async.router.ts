// This must be require and not import because of how async-express-decorator works
const toAsyncRouter = require('async-express-decorator');
import { Router, RouterOptions } from 'express';

// The decorator's defaults omit PATCH, leaving rejected PATCH handlers unhandled.
toAsyncRouter.setMethods([...toAsyncRouter.getMethods(), 'patch']);

export function asyncRouter(opts?: RouterOptions): Router {
  return toAsyncRouter(Router(opts));
}
