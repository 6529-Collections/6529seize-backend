import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCloudFormationTemplate } from './cloudformation-template.js';

const expected = {
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: {
    Relay: {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Role: { 'Fn::GetAtt': ['RelayRole', 'Arn'] },
        FunctionName: { 'Fn::Sub': 'relay-${Environment}' },
        Environment: { Variables: { REGION: { Ref: 'AWS::Region' } } }
      }
    }
  }
};

test('preserves every intrinsic when AWS returns a parsed template or JSON string', () => {
  assert.deepEqual(parseCloudFormationTemplate(expected), expected);
  assert.deepEqual(
    parseCloudFormationTemplate(JSON.stringify(expected)),
    expected
  );
});

test('preserves long-form intrinsics in original YAML templates returned by AWS', () => {
  const yaml = `AWSTemplateFormatVersion: '2010-09-09'
Resources:
  Relay:
    Type: AWS::Lambda::Function
    Properties:
      Role:
        Fn::GetAtt: [RelayRole, Arn]
      FunctionName:
        Fn::Sub: relay-\${Environment}
      Environment:
        Variables:
          REGION:
            Ref: AWS::Region
`;
  assert.deepEqual(parseCloudFormationTemplate(yaml), expected);
});

for (const body of [
  'Resources: [',
  'Resources: {}\nResources: {}',
  'Resources:\n  Relay:\n    Type: AWS::Lambda::Function\n    Properties:\n      Role: !GetAtt RelayRole.Arn',
  'Resources:\n  Relay:\n    Type: AWS::Lambda::Function\n    Properties:\n      Role: !Unrecognized opaque-value'
]) {
  test(`rejects malformed YAML or unsupported tags without including the template: ${body.slice(0, 30)}`, () => {
    assert.throws(() => parseCloudFormationTemplate(body), {
      message: 'Invalid or unsupported CloudFormation template encoding'
    });
  });
}

for (const body of [null, [], 'Resources: []', '{}', { Resources: [] }]) {
  test(`rejects a missing resource mapping: ${JSON.stringify(body)}`, () => {
    assert.throws(
      () => parseCloudFormationTemplate(body),
      /must contain a resource mapping/
    );
  });
}

for (const resource of [null, [], {}, { Type: 1 }]) {
  test(`rejects an invalid resource: ${JSON.stringify(resource)}`, () => {
    assert.throws(
      () => parseCloudFormationTemplate({ Resources: { Relay: resource } }),
      /must contain a type/
    );
  });
}
