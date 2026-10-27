// Dedicated roles are provisioned by the AWS administrator, not GitHub variables.
const role = (name) => ({ 'Fn::Sub': `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/drop-forge-staging-${name}` });
module.exports.launchRole = () => role('launch');
module.exports.distributionRole = () => role('distribution');
module.exports.schedulerRole = () => role('scheduler');
