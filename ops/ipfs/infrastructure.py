"""CloudFormation definitions for isolated storage and replaceable IPFS candidates.

Generating templates is offline. Existing shared media infrastructure is deliberately
outside these stacks: importing or cutting traffic over is a separate release.
"""
import json
from pathlib import Path

GET_ATT = 'Fn::GetAtt'
HOST_PATTERN = '[a-z0-9.-]+'
CREATE_TAGS = 'ec2:CreateTags'
ALL_TAG_VALUES_EQUAL = 'ForAllValues:StringEquals'
PUT_OBJECT = 's3:PutObject'
LIST_BUCKET = 's3:ListBucket'
TAG_DISTRIBUTION = 'cloudfront:TagResource'
DNS_ZONE_ARN = 'arn:${AWS::Partition}:route53:::hostedzone/${HostedZoneId}'
CHANGE_DNS = 'route53:ChangeResourceRecordSets'
GET_DNS_CHANGE = 'route53:GetChange'
DNS_CHANGE_ARN = 'arn:${AWS::Partition}:route53:::change/*'
GET_OBJECT_VERSION = 's3:GetObjectVersion'
GET_OBJECT = 's3:GetObject'
IAM_ROLE_TYPE = 'AWS::IAM::Role'
BUCKET_PATTERN = '[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]'

ROOT = Path(__file__).resolve().parent


def ref(name):
    return {"Ref": name}


def sub(value):
    return {"Fn::Sub": value}


def resource(kind, properties, retain=False):
    result = {"Type": kind, "Properties": properties}
    if retain:
        result.update(DeletionPolicy="Retain", UpdateReplacePolicy="Retain")
    return result


def parameter(kind="String", **kwargs):
    return {"Type": kind, **kwargs}


def template(parameters, resources, outputs):
    return {
        "AWSTemplateFormatVersion": "2010-09-09",
        "Description": "6529 IPFS: isolated persistent storage or replaceable candidate infrastructure",
        "Parameters": parameters,
        "Resources": resources,
        "Outputs": {key: {"Value": value} for key, value in outputs.items()},
    }


def storage():
    resources = {}
    for name in ("Blocks", "Backups", "Artifacts"):
        resources[name] = resource("AWS::S3::Bucket", {
            "VersioningConfiguration": {"Status": "Enabled"},
            "BucketEncryption": {"ServerSideEncryptionConfiguration": [
                {"ServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}
            ]},
            "PublicAccessBlockConfiguration": {
                "BlockPublicAcls": True, "BlockPublicPolicy": True,
                "IgnorePublicAcls": True, "RestrictPublicBuckets": True,
            },
            "OwnershipControls": {"Rules": [{"ObjectOwnership": "BucketOwnerEnforced"}]},
            "Tags": [{"Key": "Service", "Value": "6529-ipfs"},
                     {"Key": "Environment", "Value": ref("Environment")}],
        }, retain=True)
        resources[name + "Policy"] = resource("AWS::S3::BucketPolicy", {
            "Bucket": ref(name),
            "PolicyDocument": {"Version": "2012-10-17", "Statement": [{
                "Effect": "Deny", "Principal": "*", "Action": "s3:*",
                "Resource": [{GET_ATT: [name, "Arn"]}, sub("${" + name + ".Arn}/*")],
                "Condition": {"Bool": {"aws:SecureTransport": "false"}},
            }]},
        })
    return template({"Environment": parameter(AllowedValues=["staging", "prod"])},
                    resources, {name + "Bucket": ref(name) for name in ("Blocks", "Backups", "Artifacts")})


def access():
    """One-time operator bootstrap; never implicitly deployed by Actions."""
    parameters = {
        "Environment": parameter(AllowedValues=["staging", "prod"]),
        "GitHubOidcProviderArn": parameter(Description="Existing GitHub OIDC provider ARN"),
        "GitHubRepositorySubject": parameter(Default="repo:6529-Collections/6529seize-backend",
            AllowedPattern=r"repo:6529-Collections(@[0-9]+)?/6529seize-backend(@[0-9]+)?",
            Description="Repository subject prefix; supply immutable IDs exactly when enabled"),
        "HostedZoneId": parameter(),
        "DnsSuffix": parameter(AllowedPattern=HOST_PATTERN, Description="Dedicated candidate DNS suffix, never a shared production apex"),
    }
    stack_arns = [sub("arn:${AWS::Partition}:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/seize-ipfs-${Environment}-" + suffix + "/*")
                  for suffix in ("storage", "compute-*", "edge-*")]
    changeset_arn = sub("arn:${AWS::Partition}:cloudformation:${AWS::Region}:${AWS::AccountId}:changeSet/seize-ipfs-${Environment}-*/*")
    data_arn = sub("arn:${AWS::Partition}:s3:::seize-ipfs-${Environment}-storage-*")
    objects_arn = sub("arn:${AWS::Partition}:s3:::seize-ipfs-${Environment}-storage-*/*")
    runtime_arns = [sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:role/seize-ipfs-${Environment}-compute-*-runtime"),
                    sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:instance-profile/seize-ipfs-${Environment}-compute-*-runtime")]
    dns_condition = {"ForAllValues:StringLike": {
        "route53:ChangeResourceRecordSetsNormalizedRecordNames": [ref("DnsSuffix"), sub("*.${DnsSuffix}")],
    }}
    deployment = [
        {"Effect": "Allow", "Action": ["cloudformation:ListStacks"], "Resource": "*"},
        {"Effect": "Allow", "Action": ["cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet", "cloudformation:ExecuteChangeSet",
                                        "cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:UpdateTerminationProtection"], "Resource": [*stack_arns, changeset_arn]},
        {"Effect": "Allow", "Action": ["iam:PassRole"], "Resource": {GET_ATT: ["CloudFormationRole", "Arn"]},
         "Condition": {"StringEquals": {"iam:PassedToService": "cloudformation.amazonaws.com"}}},
        {"Effect": "Allow", "Action": ["ec2:DescribeInstances", "ssm:ListCommandInvocations", "ssm:DescribeInstanceInformation"], "Resource": "*"},
        {"Effect": "Allow", "Action": [CREATE_TAGS],
         "Resource": sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/*"),
         "Condition": {"StringEquals": {"ec2:ResourceTag/Service": "6529-ipfs", "ec2:ResourceTag/Environment": ref("Environment")},
                       "StringEqualsIfExists": {"aws:RequestTag/IpfsRole": "active"},
                       ALL_TAG_VALUES_EQUAL: {"aws:TagKeys": ["IpfsRole"]}}},
        {"Effect": "Allow", "Action": ["ssm:SendCommand"],
         "Resource": sub("arn:${AWS::Partition}:ssm:${AWS::Region}::document/AWS-RunShellScript")},
        {"Effect": "Allow", "Action": ["ssm:SendCommand"],
         "Resource": sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/*"),
         "Condition": {"StringEquals": {"ssm:resourceTag/Service": "6529-ipfs", "ssm:resourceTag/Environment": ref("Environment"),
                                         "ssm:resourceTag/IpfsRole": ["candidate", "active"]}}},
        {"Effect": "Allow", "Action": [PUT_OBJECT],
         "Resource": sub("arn:${AWS::Partition}:s3:::seize-ipfs-${Environment}-storage-artifacts-*/${Environment}/*")},
    ]
    infrastructure = [
        {"Effect": "Allow", "Action": ["ec2:Describe*"], "Resource": "*"},
        {"Effect": "Allow", "Action": ["ec2:RunInstances", "ec2:CreateSecurityGroup", "ec2:AllocateAddress"], "Resource": "*",
         "Condition": {"StringEquals": {"aws:RequestedRegion": ref("AWS::Region")}}},
        {"Effect": "Allow", "Action": [CREATE_TAGS, "ec2:DeleteTags", "ec2:ModifyInstanceAttribute", "ec2:TerminateInstances",
                                        "ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress", "ec2:DeleteSecurityGroup",
                                        "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupEgress",
                                        "ec2:ReleaseAddress", "ec2:AssociateAddress", "ec2:DisassociateAddress"],
         "Resource": "*", "Condition": {"StringEquals": {"ec2:ResourceTag/Environment": ref("Environment"), "ec2:ResourceTag/Service": "6529-ipfs"}}},
        {"Effect": "Allow", "Action": [CREATE_TAGS], "Resource": "*",
         "Condition": {"StringEquals": {"ec2:CreateAction": ["RunInstances", "CreateSecurityGroup", "AllocateAddress"]}}},
        {"Effect": "Allow", "Action": ["iam:CreateRole"], "Resource": runtime_arns[0],
         "Condition": {"StringEquals": {"iam:PermissionsBoundary": ref("RuntimeBoundary")}}},
        {"Effect": "Allow", "Action": ["iam:GetRole", "iam:DeleteRole", "iam:TagRole", "iam:UntagRole", "iam:PutRolePolicy",
                                        "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
                                        "iam:CreateInstanceProfile", "iam:GetInstanceProfile", "iam:DeleteInstanceProfile",
                                        "iam:ListInstanceProfilesForRole",
                                        "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile"], "Resource": runtime_arns},
        {"Effect": "Allow", "Action": ["iam:PassRole"], "Resource": runtime_arns[0],
         "Condition": {"StringEquals": {"iam:PassedToService": "ec2.amazonaws.com"}}},
        {"Effect": "Allow", "Action": ["s3:CreateBucket", "s3:DeleteBucket", "s3:GetBucket*", LIST_BUCKET, "s3:PutBucket*", "s3:DeleteBucketPolicy", "s3:GetEncryptionConfiguration", "s3:PutEncryptionConfiguration"], "Resource": data_arn},
        {"Effect": "Allow", "Action": ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:DescribeAlarms", "cloudwatch:TagResource", "cloudwatch:UntagResource"],
         "Resource": sub("arn:${AWS::Partition}:cloudwatch:${AWS::Region}:${AWS::AccountId}:alarm:seize-ipfs-${Environment}-*")},
        {"Effect": "Allow", "Action": ["cloudfront:CreateDistribution"], "Resource": "*",
         "Condition": {"StringEquals": {"aws:RequestTag/Environment": ref("Environment"), "aws:RequestTag/Service": "6529-ipfs"}}},
        {"Effect": "Allow", "Action": [TAG_DISTRIBUTION],
         "Resource": sub("arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/*"),
         "Condition": {"StringEquals": {"aws:RequestTag/Environment": ref("Environment"), "aws:RequestTag/Service": "6529-ipfs"},
                       "StringEqualsIfExists": {"aws:ResourceTag/Environment": ref("Environment"), "aws:ResourceTag/Service": "6529-ipfs"},
                       ALL_TAG_VALUES_EQUAL: {"aws:TagKeys": ["Environment", "Service"]}}},
        {"Effect": "Deny", "Action": ["cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution", TAG_DISTRIBUTION, "cloudfront:UntagResource"],
         "Resource": sub("arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/E1D6I3Z3M5F0H4")},
        {"Effect": "Allow", "Action": ["cloudfront:GetDistribution", "cloudfront:GetDistributionConfig", "cloudfront:ListTagsForResource"], "Resource": "*"},
        {"Effect": "Allow", "Action": ["cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution", TAG_DISTRIBUTION, "cloudfront:UntagResource"],
         "Resource": sub("arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/*"),
         "Condition": {"StringEquals": {"aws:ResourceTag/Environment": ref("Environment"), "aws:ResourceTag/Service": "6529-ipfs"}}},
        {"Effect": "Allow", "Action": ["route53:GetHostedZone", "route53:ListResourceRecordSets"],
         "Resource": sub(DNS_ZONE_ARN)},
        {"Effect": "Allow", "Action": [CHANGE_DNS],
         "Resource": sub(DNS_ZONE_ARN), "Condition": dns_condition},
        {"Effect": "Allow", "Action": [GET_DNS_CHANGE], "Resource": sub(DNS_CHANGE_ARN)},
    ]
    resources = {
        "RuntimeBoundary": resource("AWS::IAM::ManagedPolicy", {
            "ManagedPolicyName": sub("seize-ipfs-${Environment}-runtime-boundary"),
            "PolicyDocument": {"Version": "2012-10-17", "Statement": [
                {"Effect": "Allow", "Action": [LIST_BUCKET], "Resource": data_arn},
                {"Effect": "Allow", "Action": [GET_OBJECT, GET_OBJECT_VERSION, PUT_OBJECT], "Resource": objects_arn},
                {"Effect": "Allow", "Action": ["ssm:DescribeAssociation", "ssm:GetDeployablePatchSnapshotForInstance", "ssm:GetDocument", "ssm:DescribeDocument",
                                                "ssm:GetManifest", "ssm:ListAssociations", "ssm:ListInstanceAssociations", "ssm:PutInventory", "ssm:PutComplianceItems",
                                                "ssm:PutConfigurePackageResult", "ssm:UpdateAssociationStatus", "ssm:UpdateInstanceAssociationStatus", "ssm:UpdateInstanceInformation",
                                                "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel",
                                                "ec2messages:AcknowledgeMessage", "ec2messages:DeleteMessage", "ec2messages:FailMessage", "ec2messages:GetEndpoint", "ec2messages:GetMessages", "ec2messages:SendReply"], "Resource": "*"},
                {"Effect": "Allow", "Action": ["route53:ListHostedZones"], "Resource": "*"},
                {"Effect": "Allow", "Action": [GET_DNS_CHANGE], "Resource": sub(DNS_CHANGE_ARN)},
                {"Effect": "Allow", "Action": [CHANGE_DNS], "Resource": sub(DNS_ZONE_ARN),
                 "Condition": dns_condition},
            ]},
        }, retain=True),
        "CloudFormationRole": resource(IAM_ROLE_TYPE, {
            "RoleName": sub("seize-ipfs-${Environment}-cloudformation"),
            "AssumeRolePolicyDocument": {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "cloudformation.amazonaws.com"}, "Action": "sts:AssumeRole"}]},
            "Policies": [{"PolicyName": "ipfs-infrastructure", "PolicyDocument": {"Version": "2012-10-17", "Statement": infrastructure}}],
        }),
        "DeploymentRole": resource(IAM_ROLE_TYPE, {
            "RoleName": sub("seize-ipfs-${Environment}-deploy"),
            "AssumeRolePolicyDocument": {"Version": "2012-10-17", "Statement": [{
                "Effect": "Allow", "Principal": {"Federated": ref("GitHubOidcProviderArn")}, "Action": "sts:AssumeRoleWithWebIdentity",
                "Condition": {"StringEquals": {"token.actions.githubusercontent.com:aud": "sts.amazonaws.com", "token.actions.githubusercontent.com:sub": sub("${GitHubRepositorySubject}:environment:ipfs-${Environment}")}},
            }]},
            "Policies": [{"PolicyName": "ipfs-controller", "PolicyDocument": {"Version": "2012-10-17", "Statement": deployment}}],
        }),
    }
    return template(parameters, resources, {"DeploymentRoleArn": {GET_ATT: ["DeploymentRole", "Arn"]},
                                           "CloudFormationRoleArn": {GET_ATT: ["CloudFormationRole", "Arn"]},
                                           "RuntimeBoundaryArn": ref("RuntimeBoundary")})


def compute():
    parameters = {
        "Environment": parameter(AllowedValues=["staging", "prod"]),
        "VpcId": parameter("AWS::EC2::VPC::Id"),
        "SubnetId": parameter("AWS::EC2::Subnet::Id"),
        "ImageId": parameter("AWS::EC2::Image::Id", Description="Pinned Ubuntu 24.04 amd64 AMI with SSM Agent"),
        "InstanceType": parameter(Default="t3.large", AllowedValues=["t3.large", "t3.xlarge", "m7i.large"]),
        "BlocksBucket": parameter(AllowedPattern=BUCKET_PATTERN),
        "BackupsBucket": parameter(AllowedPattern=BUCKET_PATTERN),
        "ArtifactsBucket": parameter(AllowedPattern=BUCKET_PATTERN),
        "IngressCidr": parameter(Description="IPv4 ingress CIDR for the isolated gateway; no SSH or RPC ingress", AllowedPattern="[0-9./]+"),
        "OriginHost": parameter(AllowedPattern=HOST_PATTERN),
        "ApiHost": parameter(AllowedPattern=HOST_PATTERN),
        "HostedZoneId": parameter(),
        "RuntimeBoundaryArn": parameter(Description="RuntimeBoundaryArn output from the one-time access stack"),
        "AlarmTopicArn": parameter(Default="", Description="Optional existing SNS topic whose policy permits CloudWatch alarm delivery"),
    }
    resources = {
        "Role": resource(IAM_ROLE_TYPE, {
            "RoleName": sub("${AWS::StackName}-runtime"),
            "PermissionsBoundary": ref("RuntimeBoundaryArn"),
            "AssumeRolePolicyDocument": {"Version": "2012-10-17", "Statement": [{
                "Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole",
            }]},
            "ManagedPolicyArns": [sub("arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore")],
            "Policies": [{"PolicyName": "ipfs-data", "PolicyDocument": {
                "Version": "2012-10-17", "Statement": [
                    {"Effect": "Allow", "Action": [LIST_BUCKET],
                     "Resource": sub("arn:${AWS::Partition}:s3:::${BlocksBucket}"),
                     "Condition": {"StringLike": {"s3:prefix": ["ipfs", "ipfs/*"]}}},
                    {"Effect": "Allow", "Action": [GET_OBJECT, PUT_OBJECT],
                     "Resource": sub("arn:${AWS::Partition}:s3:::${BlocksBucket}/ipfs/*")},
                    {"Effect": "Deny", "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion"],
                     "Resource": sub("arn:${AWS::Partition}:s3:::${BlocksBucket}/*")},
                    {"Effect": "Allow", "Action": [GET_OBJECT, GET_OBJECT_VERSION, PUT_OBJECT],
                     "Resource": sub("arn:${AWS::Partition}:s3:::${BackupsBucket}/${Environment}/*")},
                    {"Effect": "Allow", "Action": [GET_OBJECT, GET_OBJECT_VERSION],
                     "Resource": sub("arn:${AWS::Partition}:s3:::${ArtifactsBucket}/${Environment}/*")},
                    {"Effect": "Allow", "Action": ["route53:ListHostedZones"], "Resource": "*"},
                    {"Effect": "Allow", "Action": [GET_DNS_CHANGE], "Resource": sub(DNS_CHANGE_ARN)},
                    {"Effect": "Allow", "Action": [CHANGE_DNS],
                     "Resource": sub(DNS_ZONE_ARN),
                     "Condition": {ALL_TAG_VALUES_EQUAL: {
                         "route53:ChangeResourceRecordSetsRecordTypes": ["TXT"],
                         "route53:ChangeResourceRecordSetsNormalizedRecordNames": [sub("_acme-challenge.${OriginHost}"), sub("_acme-challenge.${ApiHost}")],
                     }}},
                ],
            }}],
        }),
        "Profile": resource("AWS::IAM::InstanceProfile", {"InstanceProfileName": sub("${AWS::StackName}-runtime"), "Roles": [ref("Role")]}),
        "SecurityGroup": resource("AWS::EC2::SecurityGroup", {
            "GroupDescription": "IPFS candidate HTTPS only; management uses SSM",
            "VpcId": ref("VpcId"),
            "Tags": [{"Key": "Environment", "Value": ref("Environment")}, {"Key": "Service", "Value": "6529-ipfs"}],
            "SecurityGroupIngress": [{"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "CidrIp": ref("IngressCidr")}],
        }),
        "Instance": resource("AWS::EC2::Instance", {
            "ImageId": ref("ImageId"), "InstanceType": ref("InstanceType"),
            "SubnetId": ref("SubnetId"), "SecurityGroupIds": [ref("SecurityGroup")],
            "IamInstanceProfile": ref("Profile"),
            "MetadataOptions": {"HttpTokens": "required", "HttpPutResponseHopLimit": 1},
            "DisableApiTermination": True,
            "BlockDeviceMappings": [{"DeviceName": "/dev/sda1", "Ebs": {
                "VolumeSize": 30, "VolumeType": "gp3", "Encrypted": True, "DeleteOnTermination": False,
            }}],
            "Tags": [{"Key": "Name", "Value": sub("6529-ipfs-${Environment}-candidate")},
                     {"Key": "Service", "Value": "6529-ipfs"},
                     {"Key": "Environment", "Value": ref("Environment")},
                     {"Key": "IpfsRole", "Value": "candidate"}],
            "UserData": {"Fn::Base64": sub("""#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources
apt-get -o Acquire::Retries=3 update
apt-get -o Acquire::Retries=3 install -y --no-install-recommends python3 curl ca-certificates awscli
install -d -m 700 /etc/6529-ipfs
printf '%s\\n' '{"environment":"${Environment}","role":"candidate"}' > /etc/6529-ipfs/managed.json
chmod 600 /etc/6529-ipfs/managed.json
# AMI must provide SSM Agent. No IPFS process or public listener starts at boot.
systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service
""")},
        }, retain=True),
        "Address": resource("AWS::EC2::EIP", {"Domain": "vpc", "Tags": [{"Key": "Environment", "Value": ref("Environment")}, {"Key": "Service", "Value": "6529-ipfs"}]}, retain=True),
        "AddressAssociation": resource("AWS::EC2::EIPAssociation", {
            "AllocationId": {GET_ATT: ["Address", "AllocationId"]}, "InstanceId": ref("Instance"),
        }),
        "StatusAlarm": resource("AWS::CloudWatch::Alarm", {
            "AlarmDescription": "IPFS EC2 failed status check; connect AlarmActions to the monitoring account during rollout",
            "Namespace": "AWS/EC2", "MetricName": "StatusCheckFailed", "Statistic": "Maximum",
            "Period": 60, "EvaluationPeriods": 2, "Threshold": 1,
            "ComparisonOperator": "GreaterThanOrEqualToThreshold", "TreatMissingData": "breaching",
            "Dimensions": [{"Name": "InstanceId", "Value": ref("Instance")}],
            "AlarmActions": {"Fn::If": ["HasAlarmTopic", [ref("AlarmTopicArn")], ref("AWS::NoValue")]},
        }),
    }
    result = template(parameters, resources, {"InstanceId": ref("Instance"), "PublicIp": ref("Address")})
    result["Conditions"] = {"HasAlarmTopic": {"Fn::Not": [{"Fn::Equals": [ref("AlarmTopicArn"), ""]}]}}
    return result


def edge():
    # Dedicated new hostnames only. Never use this to replace the shared production
    # distribution: its Arweave/S3 behaviors are owned elsewhere.
    parameters = {
        "Environment": parameter(AllowedValues=["staging", "prod"]),
        "OriginHost": parameter(AllowedPattern=HOST_PATTERN),
        "GatewayHost": parameter(AllowedPattern=HOST_PATTERN),
        "ApiHost": parameter(AllowedPattern=HOST_PATTERN),
        "PublicIp": parameter(AllowedPattern="[0-9.]+"),
        "HostedZoneId": parameter(),
        "CertificateArn": parameter(Description="Existing us-east-1 ACM certificate for GatewayHost"),
    }
    resources = {
        "Distribution": resource("AWS::CloudFront::Distribution", {"DistributionConfig": {
            "Enabled": True, "Aliases": [ref("GatewayHost")],
            "HttpVersion": "http2", "IPV6Enabled": True,
            "ViewerCertificate": {"AcmCertificateArn": ref("CertificateArn"), "SslSupportMethod": "sni-only", "MinimumProtocolVersion": "TLSv1.2_2021"},
            "Origins": [{"Id": "ipfs", "DomainName": ref("OriginHost"), "CustomOriginConfig": {
                "OriginProtocolPolicy": "https-only", "OriginSSLProtocols": ["TLSv1.2"], "HTTPSPort": 443,
            }}],
            "DefaultCacheBehavior": {"TargetOriginId": "ipfs", "ViewerProtocolPolicy": "redirect-to-https",
                                     "AllowedMethods": ["GET", "HEAD"], "CachedMethods": ["GET", "HEAD"],
                                     "Compress": True, "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"},
            "CacheBehaviors": [{"PathPattern": "/ipfs/*", "TargetOriginId": "ipfs", "ViewerProtocolPolicy": "redirect-to-https",
                                "AllowedMethods": ["GET", "HEAD"], "CachedMethods": ["GET", "HEAD"], "Compress": True,
                                "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6"}],
        }, "Tags": [{"Key": "Environment", "Value": ref("Environment")}, {"Key": "Service", "Value": "6529-ipfs"}]}, retain=True),
    }
    for name in ("Origin", "Api"):
        resources[name + "Dns"] = resource("AWS::Route53::RecordSet", {
            "HostedZoneId": ref("HostedZoneId"), "Name": ref(name + "Host"),
            "Type": "A", "TTL": "60", "ResourceRecords": [ref("PublicIp")],
        }, retain=True)
    resources["GatewayDns"] = resource("AWS::Route53::RecordSet", {
        "HostedZoneId": ref("HostedZoneId"), "Name": ref("GatewayHost"), "Type": "A",
        "AliasTarget": {"DNSName": {GET_ATT: ["Distribution", "DomainName"]},
                        "HostedZoneId": "Z2FDTNDATAQYW2"},
    }, retain=True)
    return template(parameters, resources, {"DistributionId": ref("Distribution")})


def render(kind):
    return {"access": access, "storage": storage, "compute": compute, "edge": edge}[kind]()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=["access", "storage", "compute", "edge"])
    args = parser.parse_args()
    print(json.dumps(render(args.kind), indent=2))
