"""Adopt the observed production resources without changing their configuration.

Templates remain handwritten CloudFormation YAML. Native resource fingerprints
are review evidence, never a source from which templates are generated at runtime.
"""
import argparse
import copy
import hashlib
import json
import os
import time

import yaml

from common import ROOT, aws, environment_policy, matches, require, source_identity_guard

TEMPLATE = ROOT / "cloudformation" / "adoption.yaml"
MANIFEST = ROOT / "environments" / "adoption.json"
STACK = "seize-ipfs-prod-adopted"
POLICY = {"Statement": [{"Effect": "Deny", "Action": "Update:*", "Principal": "*", "Resource": "*"}]}
EXPECTED = {
    "Blocks": ("AWS::S3::Bucket", "BucketName", "6529ipfs"),
    "Server": ("AWS::EC2::Instance", "InstanceId", "i-0012c6236ad1292e8"),
    "ServerSecurityGroup": ("AWS::EC2::SecurityGroup", "Id", "sg-03b5af7f71e361d25"),
    "SharedDistribution": ("AWS::CloudFront::Distribution", "Id", "E1D6I3Z3M5F0H4"),
}
TERMINAL = {"IMPORT_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def remove_path(value, parts):
    if not parts:
        return
    key, *tail = parts
    if key == "*" and isinstance(value, list):
        for item in value:
            remove_path(item, tail)
    elif isinstance(value, dict) and key in value:
        if tail:
            remove_path(value[key], tail)
        else:
            del value[key]


def normalize(model, readonly):
    result = copy.deepcopy(model)
    for pointer in readonly:
        require(pointer.startswith("/properties/"), "Unknown resource-schema pointer")
        remove_path(result, pointer.split("/")[2:])
    # Import may attach AWS-owned stack tags. Custom tags remain part of the
    # baseline. Rule and tag ordering has no meaning; cache-behavior ordering does.
    if "Tags" in result:
        result["Tags"] = sorted((tag for tag in result["Tags"] if not tag["Key"].startswith("aws:")), key=lambda tag: tag["Key"])
        if not result["Tags"]:
            del result["Tags"]
    for name in ("SecurityGroupIngress", "SecurityGroupEgress"):
        if name in result:
            result[name] = sorted(result[name], key=lambda item: json.dumps(item, sort_keys=True))
    return result


def baseline():
    manifest = json.loads(MANIFEST.read_text())
    template = yaml.safe_load(TEMPLATE.read_text())
    require(manifest.get("schema") == 1 and manifest.get("accountId") == "987989283142"
            and manifest.get("region") == "us-east-1" and manifest.get("stackName") == STACK, "Unexpected adoption target")
    require(manifest.get("templateSha256") == hashlib.sha256(TEMPLATE.read_bytes()).hexdigest(), "Adoption template changed; review and refresh its baseline fingerprint")
    require(matches(r"[a-f0-9]{64}", manifest.get("distributionConfigSha256")), "Missing approved full CloudFront API configuration fingerprint")
    require(set(manifest["resources"]) == set(EXPECTED) == set(template["Resources"]), "Adoption resource set changed")
    require(not template.get("Transform") and not template.get("Outputs") and not template.get("Parameters"), "Import baseline cannot add stack attributes or parameters")
    for name, (kind, key, identifier) in EXPECTED.items():
        resource = manifest["resources"][name]
        require((resource["type"], resource["identifierKey"], resource["identifier"]) == (kind, key, identifier), "Adoption identity changed")
        declared = template["Resources"][name]
        require(declared["Type"] == kind and declared.get("DeletionPolicy") == "Retain"
                and declared.get("UpdateReplacePolicy") == "Retain", "Imported resources must be retained")
        require(matches(r"[a-f0-9]{64}", resource.get("modelSha256")), "Missing reviewed native-model fingerprint")
    return manifest, template


def region_args(manifest):
    return ("--region", manifest["region"])


def identity(manifest):
    require(aws("sts", "get-caller-identity")["Account"] == manifest["accountId"], "Adoption AWS account mismatch")


def guarded(sha, mutation=False):
    manifest, _ = baseline()
    source_identity_guard(sha, os.environ)
    if mutation:
        policy = environment_policy("prod")
        require(policy.get("adoptionEnabled") is True,
                "Production adoption is disabled in the checked-in environment policy")
        require(policy.get("changesEnabled") is False,
                "Runtime deployment must remain disabled during production adoption")
    return manifest


def model_matches(declared, actual):
    """Every declared property must match; the fingerprint covers omitted fields."""
    if isinstance(declared, dict):
        return isinstance(actual, dict) and all(key in actual and model_matches(value, actual[key]) for key, value in declared.items())
    if isinstance(declared, list):
        return isinstance(actual, list) and len(declared) == len(actual) and all(model_matches(left, right) for left, right in zip(declared, actual))
    return type(declared) is type(actual) and declared == actual


def audit(manifest, template):
    identity(manifest)
    import_schema(manifest)
    distribution = aws("cloudfront", "get-distribution-config", "--id", EXPECTED["SharedDistribution"][2])["DistributionConfig"]
    require(fingerprint(distribution) == manifest["distributionConfigSha256"], "Full CloudFront API configuration differs from the approved baseline")
    checked = []
    for name, resource in manifest["resources"].items():
        response = aws("cloudcontrol", "get-resource", *region_args(manifest), "--type-name", resource["type"], "--identifier", resource["identifier"])
        description = response["ResourceDescription"]
        require(description["Identifier"] == resource["identifier"], "Cloud Control resource identity mismatch")
        actual = normalize(json.loads(description["Properties"]), resource["readOnlyProperties"])
        require(fingerprint(actual) == resource["modelSha256"], "Live configuration differs from reviewed baseline: " + name)
        declared = normalize(template["Resources"][name]["Properties"], resource["readOnlyProperties"])
        require(model_matches(declared, actual), "Template properties differ from live configuration: " + name)
        checked.append(name)
    # These references are intentionally outside this import. Detect an instance
    # unexpectedly sharing the legacy security group before importing its rules.
    response = aws("ec2", "describe-instances", *region_args(manifest), "--filters", "Name=instance.group-id,Values=" + EXPECTED["ServerSecurityGroup"][2])
    instances = [item for row in response["Reservations"] for item in row["Instances"] if item["State"]["Name"] != "terminated"]
    require(len(instances) == 1 and instances[0]["InstanceId"] == EXPECTED["Server"][2], "Production security group is shared or its instance changed")
    require(instances[0]["State"]["Name"] == "running", "Production instance is not running; investigate before adoption")
    return {"matched": checked, "baselineSha256": fingerprint(manifest), "configurationChanged": False}


def import_schema(manifest):
    # Provider import identifiers can differ from familiar EC2 field names.
    # For example, CloudFormation currently imports a security group using Id,
    # while EC2 calls the same physical identifier GroupId. Ask AWS explicitly.
    result = aws("cloudformation", "get-template-summary", *region_args(manifest), "--template-body", "file://" + str(TEMPLATE))
    seen = set()
    for row in result["ResourceIdentifierSummaries"]:
        for name in row["LogicalResourceIds"]:
            require(name in manifest["resources"] and name not in seen, "Unexpected AWS import resource schema")
            item = manifest["resources"][name]
            require(row["ResourceType"] == item["type"] and item["identifierKey"] in row["ResourceIdentifiers"], "AWS import identifier differs from the manifest: " + name)
            seen.add(name)
    require(seen == set(EXPECTED), "AWS did not identify every import resource")


def imports(manifest):
    return [{"ResourceType": item["type"], "LogicalResourceId": name,
             "ResourceIdentifier": {item["identifierKey"]: item["identifier"]}}
            for name, item in manifest["resources"].items()]


def stack(manifest):
    summaries = aws("cloudformation", "list-stacks", *region_args(manifest))["StackSummaries"]
    rows = [row for row in summaries if row["StackName"] == STACK and row["StackStatus"] != "DELETE_COMPLETE"]
    require(len(rows) <= 1, "Ambiguous adoption stack")
    return rows[0] if rows else None


def description(sha, manifest):
    return "IPFS import only; source=" + sha + "; baseline=" + fingerprint(manifest)


def expected_change_name(sha, manifest):
    return "seize-ipfs-prod-import-" + sha + "-" + fingerprint(manifest)[:16]


def valid_import_change_set(result, manifest, sha, service_role):
    require(not result.get("NextToken"), "Paginated import change set requires review")
    # DescribeChangeSet does not return ChangeSetType or RoleARN. Require every
    # action to be Import. IAM additionally requires the import role when creating
    # a change set. A new REVIEW_IN_PROGRESS stack may not yet record that role.
    require(result.get("StackName") == STACK and result.get("Description") == description(sha, manifest), "Import change set belongs to a different source or stack")
    require(result.get("ChangeSetName") == expected_change_name(sha, manifest), "Unexpected import change set name")
    require(not result.get("Parameters") and not result.get("Tags"), "Import parameters or custom stack tags changed")
    stacks = aws("cloudformation", "describe-stacks", *region_args(manifest), "--stack-name", STACK)["Stacks"]
    require(len(stacks) == 1, "Expected one adoption stack")
    recorded = stacks[0].get("RoleARN")
    require(recorded == service_role or (recorded is None and stacks[0].get("StackStatus") == "REVIEW_IN_PROGRESS"),
            "Import execution role changed or is not recorded")
    changes = result.get("Changes", [])
    require(len(changes) == len(EXPECTED), "Import must contain exactly the reviewed resources")
    seen = set()
    for item in changes:
        change = item["ResourceChange"]
        name = change["LogicalResourceId"]
        require(name in EXPECTED and name not in seen, "Unexpected or duplicate import resource")
        seen.add(name)
        kind, _, identifier = EXPECTED[name]
        require(change["Action"] == "Import" and change["ResourceType"] == kind and change.get("PhysicalResourceId") == identifier,
                "Import would create, modify, replace, remove, or adopt an unexpected resource")


def wait_changes(manifest, change_id):
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        result = aws("cloudformation", "describe-change-set", *region_args(manifest), "--change-set-name", change_id)
        if result["Status"] == "CREATE_COMPLETE":
            return result
        require(result["Status"] in ("CREATE_PENDING", "CREATE_IN_PROGRESS"), "Import change set failed; inspect restricted CloudFormation events")
        time.sleep(5)
    raise TimeoutError("Import change set is still preparing; reconcile its ID before retrying")


def verify_template(manifest, change_id=None):
    selection = ("--change-set-name", change_id) if change_id else ("--stack-name", STACK)
    result = aws("cloudformation", "get-template", *region_args(manifest), *selection, "--template-stage", "Original")
    body = result["TemplateBody"]
    document = yaml.safe_load(body) if isinstance(body, str) else body
    require(document == yaml.safe_load(TEMPLATE.read_text()), "AWS import template differs from the reviewed YAML")


def prepare(manifest, template, sha, service_role):
    audit(manifest, template)
    current = stack(manifest)
    require(not current or current["StackStatus"] == "REVIEW_IN_PROGRESS", "Existing adoption stack requires verification, not another import")
    name = expected_change_name(sha, manifest)
    if current:
        rows = aws("cloudformation", "list-change-sets", *region_args(manifest), "--stack-name", STACK)["Summaries"]
        matching = [row for row in rows if row["ChangeSetName"] == name]
        require(len(matching) == 1, "Another import is pending; reconcile it explicitly before proceeding")
        change_id = matching[0]["ChangeSetId"]
    else:
        result = aws("cloudformation", "create-change-set", *region_args(manifest), "--stack-name", STACK,
                     "--change-set-name", name, "--change-set-type", "IMPORT", "--resources-to-import", json.dumps(imports(manifest)),
                     "--template-body", "file://" + str(TEMPLATE), "--role-arn", service_role,
                     "--description", description(sha, manifest), "--client-token", name)
        change_id = result["Id"]
    result = wait_changes(manifest, change_id)
    valid_import_change_set(result, manifest, sha, service_role)
    require(result.get("ExecutionStatus") == "AVAILABLE", "Import change set is not available")
    verify_template(manifest, change_id)
    return {"changeSetId": change_id, "sourceSha": sha, "baselineSha256": fingerprint(manifest), "executed": False}


def ownership(manifest):
    result = aws("cloudformation", "list-stack-resources", *region_args(manifest), "--stack-name", STACK)["StackResourceSummaries"]
    actual = {row["LogicalResourceId"]: (row["ResourceType"], row["PhysicalResourceId"]) for row in result}
    expected = {name: (kind, identifier) for name, (kind, _, identifier) in EXPECTED.items()}
    require(len(result) == len(expected) and actual == expected, "CloudFormation ownership differs from the adoption manifest")


def verify(manifest, template):
    current = stack(manifest)
    require(current and current["StackStatus"] in TERMINAL, "Import is not complete; inspect stack events before retrying")
    ownership(manifest)
    verify_template(manifest)
    stacks = aws("cloudformation", "describe-stacks", *region_args(manifest), "--stack-name", STACK)["Stacks"]
    expected_role = "arn:aws:iam::" + manifest["accountId"] + ":role/seize-ipfs-prod-adoption-service"
    require(len(stacks) == 1 and stacks[0].get("RoleARN") == expected_role, "Imported stack must retain its import-only service role")
    audit(manifest, template)
    for name in EXPECTED:
        result = aws("cloudformation", "detect-stack-resource-drift", *region_args(manifest), "--stack-name", STACK, "--logical-resource-id", name, timeout=600)
        require(result["StackResourceDrift"]["StackResourceDriftStatus"] == "IN_SYNC", "Imported resource is drifted or unchecked: " + name)
    return {"stackName": STACK, "ownershipVerified": True, "driftStatus": "IN_SYNC", "configurationChanged": False}


def protect(manifest):
    aws("cloudformation", "update-termination-protection", *region_args(manifest), "--stack-name", STACK, "--enable-termination-protection")
    # Future configuration updates need a separate reviewed controller and role. Even
    # accidental calls by a privileged operator meet this deny-all stack policy.
    aws("cloudformation", "set-stack-policy", *region_args(manifest), "--stack-name", STACK, "--stack-policy-body", json.dumps(POLICY))


def execute(manifest, template, sha, service_role, change_id):
    prefix = "arn:aws:cloudformation:" + manifest["region"] + ":" + manifest["accountId"] + ":changeSet/" + expected_change_name(sha, manifest) + "/"
    require(isinstance(change_id, str) and change_id.startswith(prefix) and matches(r"[a-zA-Z0-9-]+", change_id[len(prefix):]), "An exact prepared import change-set ARN is required")
    identity(manifest)
    result = aws("cloudformation", "describe-change-set", *region_args(manifest), "--change-set-name", change_id)
    require(result.get("ChangeSetId") == change_id, "AWS returned a different change set")
    valid_import_change_set(result, manifest, sha, service_role)
    verify_template(manifest, change_id)
    status = result.get("ExecutionStatus")
    if status == "AVAILABLE":
        require(stack(manifest)["StackStatus"] == "REVIEW_IN_PROGRESS", "Import stack is no longer awaiting its initial import")
        audit(manifest, template)
        aws("cloudformation", "execute-change-set", *region_args(manifest), "--change-set-name", change_id,
            "--client-request-token", expected_change_name(sha, manifest))
    else:
        require(status in ("EXECUTE_IN_PROGRESS", "EXECUTE_COMPLETE"), "Import cannot be retried in its current state")
    # A timeout is not rollback. Retry with this same ARN: never CREATE/UPDATE or
    # an automatically selected 'latest' change set after an ambiguous outcome.
    aws("cloudformation", "wait", "stack-import-complete", *region_args(manifest), "--stack-name", STACK, timeout=3600)
    protect(manifest)
    return verify(manifest, template)


def service_role(manifest):
    expected = "arn:aws:iam::" + manifest["accountId"] + ":role/seize-ipfs-prod-adoption-service"
    require(os.environ.get("IPFS_ADOPTION_SERVICE_ROLE_ARN") == expected, "Unexpected adoption service role")
    return expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["plan", "audit", "prepare", "execute", "verify"])
    parser.add_argument("--sha", default="")
    parser.add_argument("--change-set-id", default="")
    args = parser.parse_args()
    manifest, template = baseline()
    if args.operation == "plan":
        print(json.dumps({"stackName": STACK, "template": str(TEMPLATE.relative_to(ROOT)), "resourcesToImport": imports(manifest),
                          "baselineSha256": fingerprint(manifest), "configurationChanged": False}))
        return
    guarded(args.sha, mutation=args.operation in ("prepare", "execute"))
    if args.operation == "audit":
        result = audit(manifest, template)
    elif args.operation == "prepare":
        result = prepare(manifest, template, args.sha, service_role(manifest))
    elif args.operation == "execute":
        result = execute(manifest, template, args.sha, service_role(manifest), args.change_set_id)
    else:
        result = verify(manifest, template)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
