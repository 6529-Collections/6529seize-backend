module.exports.subnets = () => {
  return ['subnet-08dbb020dea1a658d', 'subnet-003b0c8ce57cb67c2'];
};

module.exports.security = () => {
  return ['sg-033f6ed509ce4c3a4', 'sg-0b548abc33e4c84a3'];
};

module.exports.region = () => {
  return 'us-east-1';
};

// Production still uses literal network IDs; only the account is derived so
// no AWS account ID is hardcoded in deploy configuration.
module.exports.cwtopic = async ({ resolveVariable }) => {
  const accountId = await resolveVariable('aws:accountId');
  return `arn:aws:sns:us-east-1:${accountId}:cloudwatch-alarms`;
};
