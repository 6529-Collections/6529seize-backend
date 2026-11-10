"""Explicit GitHub Actions controller. No AWS calls are made by plan/validate."""
import argparse
import base64
import json
import os
import shlex
import time
import uuid
from pathlib import Path

import yaml

from common import ROOT, RECEIPT_PROTOCOL, aws, digest, matches, mutation_guard, require, source_guard, validate_config

TEMPLATE_PATHS = {
    "access": ROOT / "cloudformation" / "access.yaml",
    "storage": ROOT / "cloudformation" / "storage.yaml",
    "compute": ROOT / "cloudformation" / "compute.yaml",
    "edge": ROOT / "cloudformation" / "edge.yaml",
}


def template_path(kind):
    require(kind in TEMPLATE_PATHS, "Unknown CloudFormation template")
    return TEMPLATE_PATHS[kind]


def load_template(kind):
    source = template_path(kind).read_text()
    require(len(source.encode()) < 51200, "Template exceeds inline limit")
    document = yaml.safe_load(source)
    require(isinstance(document, dict) and isinstance(document.get("Parameters"), dict)
            and isinstance(document.get("Resources"), dict), "Invalid CloudFormation template")
    return document


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
    require(isinstance(supplied, dict), "Infrastructure parameters must be a JSON object")
    definitions = load_template(kind)["Parameters"]
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
            # Empty Changes can also accompany authorization/template errors;
            # only recognized empty-update failures are successful no-ops.
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
            "template": load_template(args.kind), "parameters": stack_parameters(config, args.kind, args.parameters)}


def apply(config, args):
    document = plan(config, args)
    name = document["stackName"]
    # AWS CLI automatically paginates list-stacks when --no-paginate is absent.
    # Describe the full stack list instead of treating an AccessDenied/error as
    # a nonexistent stack. Never fall back from failed reads to CREATE.
    existing = aws("cloudformation", "list-stacks", "--region", config["region"])["StackSummaries"]
    found = [stack for stack in existing if stack["StackName"] == name and stack["StackStatus"] != "DELETE_COMPLETE"]
    require(not found or args.kind == "storage", "Candidate stacks are immutable; use a new slot")
    if args.kind == "edge":
        instance = candidate(config, allow_active=True)
        public_ip = next(item["ParameterValue"] for item in document["parameters"] if item["ParameterKey"] == "PublicIp")
        require(public_ip == instance.get("PublicIpAddress"), "Edge must point to the verified candidate")
        command(config, "python3 /opt/6529-ipfs/current/host.py verify", "verify")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "1")
    require(matches(r"[0-9]+", run_id) and matches(r"[0-9]+", attempt), "Missing Actions run identity")
    change_name = "seize-ipfs-" + config["environment"] + "-" + args.sha + "-" + run_id + "-" + attempt + "-" + uuid.uuid4().hex[:8]
    change_set = aws("cloudformation", "create-change-set", "--region", config["region"],
                     "--stack-name", name, "--change-set-name", change_name,
                     "--change-set-type", "UPDATE" if found else "CREATE",
                     "--template-body", "file://" + str(template_path(args.kind)), "--parameters", json.dumps(document["parameters"]),
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
        command(config, "python3 /opt/6529-ipfs/current/host.py seal", "seal")
        aws("ec2", "create-tags", "--region", config["region"], "--resources", config["instanceId"],
            "--tags", "Key=IpfsRole,Value=active")
    aws("cloudformation", "execute-change-set", "--region", config["region"], "--change-set-name", change_id)
    aws("cloudformation", "wait", "stack-update-complete" if found else "stack-create-complete",
        "--region", config["region"], "--stack-name", name, timeout=3600)
    aws("cloudformation", "update-termination-protection", "--region", config["region"],
        "--stack-name", name, "--enable-termination-protection")
    result = aws("cloudformation", "describe-stacks", "--region", config["region"], "--stack-name", name)
    return {"stackName": name, "outputs": result["Stacks"][0].get("Outputs", [])}


def wait_ssm_online(config):
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        nodes = aws("ssm", "describe-instance-information", "--region", config["region"],
                    "--filters", json.dumps([{"Key": "InstanceIds", "Values": [config["instanceId"]]}]))["InstanceInformationList"]
        if len(nodes) == 1 and nodes[0]["PingStatus"] == "Online":
            return
        time.sleep(10)
    raise TimeoutError("Candidate SSM Agent did not become ready")


def wait_command(config, command_id):
    deadline = time.monotonic() + 7300
    pending_details = 0
    while time.monotonic() < deadline:
        time.sleep(10)
        # list-command-invocations is safe before eventual-consistency delivery;
        # no success is inferred from an empty list.
        rows = aws("ssm", "list-command-invocations", "--region", config["region"],
                   "--command-id", command_id, "--details")["CommandInvocations"]
        if not rows:
            continue
        require(len(rows) == 1, "Expected exactly one SSM target")
        status = rows[0]["Status"]
        if status in ("Pending", "InProgress", "Delayed", "Cancelling"):
            continue
        require(status == "Success", "SSM operation failed; command ID " + command_id + "; inspect restricted logs")
        plugins = rows[0].get("CommandPlugins", [])
        if not plugins:
            pending_details += 1
            require(pending_details <= 3, "SSM plugin details did not become available")
            continue
        require(len(plugins) == 1 and plugins[0].get("ResponseCode") == 0,
                "SSM plugin failed; inspect restricted command logs")
        return plugins[0].get("Output", "")
    raise TimeoutError("SSM command still pending: " + command_id)


def valid_receipt_field(key, value):
    if key in ("pinCount", "restoredPins"):
        return type(value) is int and value >= 0
    if key in ("uploadPinRead", "mfsVerified", "independentIdentity"):
        return value is True
    if key == "role":
        return value == "active"
    return isinstance(value, str) and bool(value)


def parse_receipt(output, operation):
    verification_fields = ("version", "pinCount", "uploadPinRead")
    fields = {
        "install": verification_fields,
        "verify": verification_fields,
        "backup": ("backupKey", "versionId", "pinCount"),
        "restore": ("restoredPins", "mfsVerified", "independentIdentity"),
        "seal": ("role",),
    }[operation]
    for line in reversed(output.splitlines()):
        try:
            envelope = json.loads(line)
        except ValueError:
            continue
        if not isinstance(envelope, dict) or envelope.get("protocol") != RECEIPT_PROTOCOL:
            continue
        require(envelope.get("operation") == operation, "SSM receipt operation mismatch")
        receipt = envelope.get("result")
        require(isinstance(receipt, dict), "Missing SSM operation receipt")
        require(all(key in receipt and valid_receipt_field(key, receipt[key]) for key in fields),
                "Missing or invalid required SSM receipt fields; inspect restricted command logs")
        return {key: receipt[key] for key in fields}
    raise ValueError("No valid SSM operation receipt; inspect restricted command logs")


def command(config, commands, operation):
    wait_ssm_online(config)
    result = aws("ssm", "send-command", "--region", config["region"], "--instance-ids", config["instanceId"],
                 "--document-name", "AWS-RunShellScript", "--parameters",
                 json.dumps({"commands": ["set -eu\numask 077\n" + commands], "executionTimeout": ["7200"]}),
                 "--comment", "6529 IPFS candidate management")
    command_id = result["Command"]["CommandId"]
    try:
        receipt = parse_receipt(wait_command(config, command_id), operation)
    except ValueError as error:
        raise ValueError(str(error) + "; command ID " + command_id) from None
    return {"commandId": command_id, "status": "Success", **receipt}


def host_operation(config, args):
    candidate(config, allow_active=args.operation in ("backup", "verify"))
    if args.operation == "deploy":
        require(args.bundle and matches(r"[a-f0-9]{64}", args.bundle_sha256), "A verified bundle is required")
        runner_directory = os.environ.get("RUNNER_TEMP")
        require(runner_directory, "RUNNER_TEMP is required for Actions deployment")
        artifact_directory = Path(runner_directory).resolve()
        require(Path(args.bundle).resolve() == artifact_directory / "ipfs-bundle.tar.gz", "Bundle must be the runner's prepared release archive")
        require(digest(args.bundle, artifact_directory) == args.bundle_sha256, "Bundle checksum mismatch")
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
        return command(config, script, "install")
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
    return command(config, script, args.operation)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["validate", "plan", "apply", "deploy", "backup", "restore", "verify"])
    parser.add_argument("--config", type=Path)
    parser.add_argument("--environment", choices=["prod"], default="prod")
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
        for kind in TEMPLATE_PATHS:
            load_template(kind)
        print("IPFS YAML templates load offline; no AWS credentials or live endpoints used")
        return
    config = validate_config(json.loads(args.config.read_text()) if args.config else json.loads(os.environ["IPFS_CONFIG"]))
    require(config["environment"] == args.environment, "Environment selection mismatch")
    if args.operation == "plan":
        if args.sha or os.environ.get("GITHUB_ACTIONS") == "true":
            source_guard(config, args.sha, os.environ)
        print(json.dumps(plan(config, args), indent=2))
        return
    mutation_guard(config, args.sha, os.environ)
    account(config)
    result = apply(config, args) if args.operation == "apply" else host_operation(config, args)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
