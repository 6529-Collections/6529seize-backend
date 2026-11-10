"""Explicit GitHub Actions controller. No AWS calls are made by render/validate."""
import argparse
import base64
import json
import os
import shlex
import tempfile
import time
from pathlib import Path

from common import ROOT, aws, digest, matches, mutation_guard, require, validate_config
from infrastructure import render


def account(config):
    require(aws("sts", "get-caller-identity")["Account"] == config["accountId"], "AWS account mismatch")


def candidate(config, allow_active=False):
    result = aws("ec2", "describe-instances", "--region", config["region"], "--instance-ids", config["instanceId"])
    instances = [item for reservation in result["Reservations"] for item in reservation["Instances"]]
    require(len(instances) == 1, "Expected one candidate instance")
    instance = instances[0]
    tags = {tag["Key"]: tag["Value"] for tag in instance.get("Tags", [])}
    require(tags.get("Service") == "6529-ipfs" and tags.get("Environment") == config["environment"]
            and tags.get("IpfsRole") in (("candidate", "active") if allow_active else ("candidate",)), "Target is not an isolated managed candidate")
    require(instance["State"]["Name"] == "running", "Candidate is not running")
    return instance


def stack_name(config, kind, slot):
    require(matches(r"[a-z][a-z0-9-]{0,24}", slot), "Invalid candidate slot")
    suffix = "" if kind == "storage" else "-" + slot
    return "seize-ipfs-" + config["environment"] + "-" + kind + suffix


def stack_parameters(config, kind, supplied):
    definitions = render(kind)["Parameters"]
    values = {"Environment": config["environment"]}
    mapped = {"BlocksBucket": "blocksBucket", "BackupsBucket": "backupsBucket", "ArtifactsBucket": "artifactsBucket",
              "OriginHost": "originHost", "ApiHost": "apiHost", "GatewayHost": "gatewayHost", "HostedZoneId": "hostedZoneId"}
    for name, key in mapped.items():
        if name in definitions:
            values[name] = config[key]
    require(not set(supplied).difference(definitions), "Unknown infrastructure parameter")
    require(not set(supplied).intersection(values), "Environment and data parameters cannot be overridden")
    values.update(supplied)
    for name, definition in definitions.items():
        require(name in values or "Default" in definition, "Missing parameter " + name)
    return [{"ParameterKey": key, "ParameterValue": str(value)} for key, value in values.items()]


def reject_destructive_changes(changes):
    for item in changes:
        change = item["ResourceChange"]
        require(change["Action"] != "Remove", "Resource removal requires a separate reviewed migration")
        require(change.get("Replacement", "False") == "False", "Resource replacement requires a new candidate slot")


def wait_change_set(config, change_id):
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        result = aws("cloudformation", "describe-change-set", "--region", config["region"], "--change-set-name", change_id)
        if result["Status"] == "CREATE_COMPLETE":
            return result
        if result["Status"] == "FAILED":
            reason = result.get("StatusReason", "")
            if "didn't contain changes" in reason or "No updates are to be performed" in reason:
                return None
            raise RuntimeError("CloudFormation change set failed; inspect its restricted AWS diagnostics")
        time.sleep(5)
    raise TimeoutError("CloudFormation change set did not complete")


def plan(config, args):
    # Offline plan: same document used for a future apply. Does not create an AWS
    # change set, assume credentials, or mutate the existing environment.
    return {"stackName": stack_name(config, args.kind, args.slot),
            "template": render(args.kind), "parameters": stack_parameters(config, args.kind, args.parameters)}


def apply(config, args):
    document = plan(config, args)
    name = document["stackName"]
    # Describe the full stack list instead of treating an AccessDenied/error as
    # a nonexistent stack. Never fall back from failed reads to CREATE.
    existing = aws("cloudformation", "list-stacks", "--region", config["region"])["StackSummaries"]
    found = [stack for stack in existing if stack["StackName"] == name and stack["StackStatus"] != "DELETE_COMPLETE"]
    require(not found or args.kind == "storage", "Candidate stacks are immutable; use a new slot")
    if args.kind == "edge":
        instance = candidate(config, allow_active=True)
        public_ip = next(item["ParameterValue"] for item in document["parameters"] if item["ParameterKey"] == "PublicIp")
        require(public_ip == instance.get("PublicIpAddress"), "Edge must point to the verified candidate")
        command(config, "python3 /opt/6529-ipfs/current/host.py verify")
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "template.json"
        path.write_text(json.dumps(document["template"]))
        run_id = os.environ.get("GITHUB_RUN_ID", "")
        attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "1")
        require(matches(r"[0-9]+", run_id) and matches(r"[0-9]+", attempt), "Missing Actions run identity")
        change_name = "seize-ipfs-" + config["environment"] + "-" + args.sha + "-" + run_id + "-" + attempt
        change_set = aws("cloudformation", "create-change-set", "--region", config["region"],
                         "--stack-name", name, "--change-set-name", change_name,
                         "--change-set-type", "UPDATE" if found else "CREATE",
                         "--template-body", "file://" + str(path), "--parameters", json.dumps(document["parameters"]),
                         "--capabilities", "CAPABILITY_NAMED_IAM", "--description", "IPFS reviewed source " + args.sha,
                         "--role-arn", os.environ["IPFS_CLOUDFORMATION_ROLE_ARN"])
    change_id = change_set["Id"]
    description = wait_change_set(config, change_id)
    if description is None:
        return {"stackName": name, "changed": False}
    require(not description.get("NextToken"), "Paginated change sets require manual review")
    reject_destructive_changes(description["Changes"])
    if args.kind == "edge":
        # Seal the candidate before DNS can publish it. Even a failed edge
        # deployment cannot subsequently restore over a potentially live host.
        command(config, "python3 /opt/6529-ipfs/current/host.py seal")
        aws("ec2", "create-tags", "--region", config["region"], "--resources", config["instanceId"],
            "--tags", "Key=IpfsRole,Value=active")
    aws("cloudformation", "execute-change-set", "--region", config["region"], "--change-set-name", change_id)
    aws("cloudformation", "wait", "stack-update-complete" if found else "stack-create-complete",
        "--region", config["region"], "--stack-name", name, timeout=3600)
    aws("cloudformation", "update-termination-protection", "--region", config["region"],
        "--stack-name", name, "--enable-termination-protection")
    result = aws("cloudformation", "describe-stacks", "--region", config["region"], "--stack-name", name)
    return {"stackName": name, "outputs": result["Stacks"][0].get("Outputs", [])}


def command(config, commands):
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        nodes = aws("ssm", "describe-instance-information", "--region", config["region"],
                    "--filters", json.dumps([{"Key": "InstanceIds", "Values": [config["instanceId"]]}]))["InstanceInformationList"]
        if len(nodes) == 1 and nodes[0]["PingStatus"] == "Online":
            break
        time.sleep(10)
    else:
        raise TimeoutError("Candidate SSM Agent did not become ready")
    result = aws("ssm", "send-command", "--region", config["region"], "--instance-ids", config["instanceId"],
                 "--document-name", "AWS-RunShellScript", "--parameters",
                 json.dumps({"commands": ["set -eu\numask 077\n" + commands], "executionTimeout": ["7200"]}),
                 "--comment", "6529 IPFS candidate management")
    command_id = result["Command"]["CommandId"]
    deadline = time.monotonic() + 7300
    while time.monotonic() < deadline:
        time.sleep(10)
        # list-command-invocations is safe before eventual-consistency delivery;
        # no success is inferred from an empty list.
        rows = aws("ssm", "list-command-invocations", "--region", config["region"],
                   "--command-id", command_id, "--details")["CommandInvocations"]
        if not rows:
            continue
        status = rows[0]["Status"]
        if status in ("Pending", "InProgress", "Delayed", "Cancelling"):
            continue
        require(status == "Success", "SSM operation failed; command ID " + command_id + "; inspect restricted logs")
        plugins = rows[0].get("CommandPlugins", [])
        require(len(plugins) == 1 and plugins[0].get("ResponseCode") == 0,
                "SSM plugin failed; inspect restricted command logs")
        result = {"commandId": command_id, "status": status}
        try:
            receipt = json.loads(plugins[0].get("Output", "").splitlines()[-1])
        except (ValueError, IndexError):
            receipt = {}
        for key in ("backupKey", "versionId", "pinCount", "version", "uploadPinRead", "restoredPins", "mfsVerified", "independentIdentity", "role"):
            if key in receipt:
                result[key] = receipt[key]
        return result
    raise TimeoutError("SSM command still pending: " + command_id)


def host_operation(config, args):
    candidate(config, allow_active=args.operation in ("backup", "verify"))
    if args.operation == "deploy":
        require(args.bundle and matches(r"[a-f0-9]{64}", args.bundle_sha256), "A verified bundle is required")
        require(digest(args.bundle) == args.bundle_sha256, "Bundle checksum mismatch")
        key = config["environment"] + "/" + args.sha + "/bundle-" + args.bundle_sha256 + ".tar.gz"
        result = aws("s3api", "put-object", "--region", config["region"], "--bucket", config["artifactsBucket"],
                     "--key", key, "--body", str(Path(args.bundle).resolve()), "--server-side-encryption", "AES256")
        require(result.get("VersionId") not in (None, "null"), "Artifact bucket must have versioning enabled")
        # Configuration contains only validated public settings. Credentials and
        # node identities are never supplied by GitHub or printed in run logs.
        encoded = base64.b64encode(json.dumps(config).encode()).decode()
        bootstrap = (ROOT / "bootstrap.sh").read_text()
        variables = {
            "IPFS_ARTIFACT_BUCKET": config["artifactsBucket"], "IPFS_ARTIFACT_KEY": key,
            "IPFS_ARTIFACT_VERSION": result["VersionId"], "IPFS_BUNDLE_SHA256": args.bundle_sha256,
            "IPFS_SOURCE_SHA": args.sha, "IPFS_CONFIG_BASE64": encoded,
            "IPFS_REGION": config["region"],
        }
        script = "cloud-init status --wait\n" + "\n".join("export " + key + "=" + shlex.quote(value) for key, value in variables.items()) + "\n" + bootstrap
        return command(config, script)
    backup = args.backup_key or ""
    require(not backup or (backup.startswith(config["environment"] + "/") and
                           matches(r"[a-zA-Z0-9/_.-]+", backup) and ".." not in backup), "Invalid backup key")
    require(args.operation != "restore" or backup, "Restore requires an explicit backup key")
    script = "python3 /opt/6529-ipfs/current/host.py " + shlex.quote(args.operation)
    if backup:
        script += " --backup-key " + shlex.quote(backup)
    if args.operation == "restore":
        require(matches(r"[a-zA-Z0-9+/=_.-]+", args.backup_version), "Restore requires the exact recorded backup version")
        script += " --backup-version " + shlex.quote(args.backup_version)
    return command(config, script)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["validate", "plan", "apply", "deploy", "backup", "restore", "verify"])
    parser.add_argument("--config", type=Path)
    parser.add_argument("--environment", choices=["staging", "prod"], default="staging")
    parser.add_argument("--sha", default="")
    parser.add_argument("--kind", choices=["storage", "compute", "edge"], default="storage")
    parser.add_argument("--slot", default="candidate")
    parser.add_argument("--parameters", type=json.loads, default={})
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--bundle-sha256")
    parser.add_argument("--backup-key")
    parser.add_argument("--backup-version")
    args = parser.parse_args()
    if args.operation == "validate":
        for kind in ("access", "storage", "compute", "edge"):
            require(len(json.dumps(render(kind)).encode()) < 51200, "Template exceeds inline limit")
        print("IPFS templates render offline; no AWS credentials or live endpoints used")
        return
    config = validate_config(json.loads(args.config.read_text()) if args.config else json.loads(os.environ["IPFS_CONFIG"]))
    require(config["environment"] == args.environment, "Environment selection mismatch")
    if args.operation == "plan":
        print(json.dumps(plan(config, args), indent=2))
        return
    mutation_guard(config, args.sha, os.environ)
    account(config)
    result = apply(config, args) if args.operation == "apply" else host_operation(config, args)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
