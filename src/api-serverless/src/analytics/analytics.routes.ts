import { asyncRouter } from '../async.router';
import cicAnalyticsRoutes from './cic-analytics.routes';

const router = asyncRouter();

router.use('/cic', cicAnalyticsRoutes);

export default router;
