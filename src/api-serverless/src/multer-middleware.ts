// This must be require and not import because of how multer works
const multerMiddleware = require('multer');

export function initMulterSingleMiddleware(v: string) {
  const storage = multerMiddleware.memoryStorage();
  const m = multerMiddleware({ storage: storage });
  return m.single(v);
}
