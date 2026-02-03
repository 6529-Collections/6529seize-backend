import 'tsconfig-paths/register';
import { disconnect } from '../../db-api';
import { Logger } from '../../logging';

const logger = Logger.get('GLOBAL_TEARDOWN');

module.exports = async () => {
  // Close database connection pools first
  try {
    await disconnect();
  } catch (error) {
    // Log but don't throw - teardown should complete even if cleanup fails
    logger.error(`Error disconnecting database: ${error}`);
  }

  // Give a small delay to ensure connections are fully closed
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Stop MySQL container
  const container = (global as any).__MYSQL__;
  if (container) {
    try {
      await container.stop();
    } catch (error) {
      // Log but don't throw - teardown should complete even if cleanup fails
      logger.error(`Error stopping MySQL container: ${error}`);
    }
  }
};
