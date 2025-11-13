import { disconnect } from '../../db-api';

module.exports = async () => {
  // Close database connection pools first
  try {
    await disconnect();
  } catch (error) {
    // Ignore errors during teardown
  }

  // Give a small delay to ensure connections are fully closed
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Stop MySQL container
  const container = (global as any).__MYSQL__;
  if (container) {
    try {
      await container.stop();
    } catch (error) {
      // Ignore errors during container stop
    }
  }
};
