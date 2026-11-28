#!/usr/bin/env python3
"""Create (or rotate) the SES SMTP credential for the Sentry host.

Creates an access key for the stack's SMTP-only IAM user, derives the SES SMTP
password from it, writes both to SSM Parameter Store as SecureStrings, and then
deletes the user's older access keys. Nothing secret is printed.

Run with credentials for the monitoring account, for example the
AWSControlTowerExecution role. Afterwards re-run host/install-sentry.sh (it
rewrites .env.custom from the parameters) so the SMTP relay picks up the key.

usage: rotate-ses-smtp-credentials.py <smtp-user-name> [--region us-east-1]
       [--prefix /sentry-selfhost/ses]
"""
import argparse
import base64
import hashlib
import hmac

import boto3

TAGS = [{"Key": "Project", "Value": "sentry-selfhost"}, {"Key": "Owner", "Value": "6529"}]


def _sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def smtp_password(secret_access_key: str, region: str) -> str:
    """SES SMTP password derivation documented by AWS (SigV4, version 4)."""
    signature = _sign(("AWS4" + secret_access_key).encode("utf-8"), "11111111")
    for part in (region, "ses", "aws4_request", "SendRawEmail"):
        signature = _sign(signature, part)
    return base64.b64encode(bytes([0x04]) + signature).decode("utf-8")


def put_secure(ssm, name: str, value: str, description: str) -> None:
    try:
        ssm.get_parameter(Name=name)
        exists = True
    except ssm.exceptions.ParameterNotFound:
        exists = False
    if exists:
        ssm.put_parameter(Name=name, Value=value, Type="SecureString", Overwrite=True, Description=description)
    else:
        ssm.put_parameter(Name=name, Value=value, Type="SecureString", Description=description, Tags=TAGS)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("user_name")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--prefix", default="/sentry-selfhost/ses")
    args = parser.parse_args()

    iam = boto3.client("iam")
    ssm = boto3.client("ssm", region_name=args.region)

    old_keys = [k["AccessKeyId"] for k in iam.list_access_keys(UserName=args.user_name)["AccessKeyMetadata"]]
    if len(old_keys) > 1:
        raise SystemExit("the user already has two access keys; delete the unused one first")

    key = iam.create_access_key(UserName=args.user_name)["AccessKey"]
    put_secure(ssm, f"{args.prefix}/smtp-username", key["AccessKeyId"], "SES SMTP username for the Sentry host")
    put_secure(
        ssm,
        f"{args.prefix}/smtp-password",
        smtp_password(key["SecretAccessKey"], args.region),
        "SES SMTP password for the Sentry host",
    )
    print(f"stored a new SMTP credential (access key ...{key['AccessKeyId'][-4:]}) under {args.prefix}/")

    for old in old_keys:
        iam.delete_access_key(UserName=args.user_name, AccessKeyId=old)
        print(f"deleted the previous access key ...{old[-4:]}")


if __name__ == "__main__":
    main()
