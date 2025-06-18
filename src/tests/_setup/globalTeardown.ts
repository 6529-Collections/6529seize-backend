module.exports = async () => {
  const container = (global as any).__MYSQL__;
  if (container) {
    await container.stop();
  }
};
