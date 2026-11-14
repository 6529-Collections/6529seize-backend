// Staging network settings are read from SSM Parameter Store in the account
// being deployed to, so the same configuration works in any AWS account that
// publishes the shared /6529/workload parameters. Each parameter is fetched
// once per Serverless run (the provider caches identical SSM requests).
const REGION = 'eu-west-1';

const ssm = (resolveVariable, name) =>
  resolveVariable(`ssm(${REGION}):${name}`);

const requireList = (value, name) => {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const items = list.map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) {
    throw new Error(`SSM parameter ${name} is missing or empty in ${REGION}`);
  }
  return items;
};

const requireString = (value, name) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new Error(`SSM parameter ${name} is missing or empty in ${REGION}`);
  }
  return text;
};

const SUBNETS_PARAM = '/6529/workload/vpc/lambda-subnet-ids';
const SECURITY_GROUPS_PARAM = '/6529/workload/vpc/lambda-security-group-ids';
const ALARMS_TOPIC_PARAM = '/6529/workload/alarms-topic-arn';

module.exports.subnets = async ({ resolveVariable }) =>
  requireList(await ssm(resolveVariable, SUBNETS_PARAM), SUBNETS_PARAM);

module.exports.security = async ({ resolveVariable }) =>
  requireList(
    await ssm(resolveVariable, SECURITY_GROUPS_PARAM),
    SECURITY_GROUPS_PARAM
  );

module.exports.region = () => {
  return REGION;
};

module.exports.cwtopic = async ({ resolveVariable }) =>
  requireString(
    await ssm(resolveVariable, ALARMS_TOPIC_PARAM),
    ALARMS_TOPIC_PARAM
  );
