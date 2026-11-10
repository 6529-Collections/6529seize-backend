"""Validation shared by offline tooling, the controller, and the managed host."""
import hashlib
import json
import re
import subprocess
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROD_BUCKET = "6529ipfs"
PROD_INSTANCE = "i-0012c6236ad1292e8"
PROD_HOSTS = {"ipfs.6529.io", "ipfs-origin.6529.io", "api-ipfs.6529.io", "ipfs-cache.6529.io", "media.6529.io"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def extract(archive, destination, limit=600 * 1024 * 1024):
    destination = Path(destination).resolve()
    with tarfile.open(archive, "r:gz") as source:
        members = []
        total = 0
        for item in source:
            members.append(item)
            total += item.size
            require(len(members) <= 1024 and total <= limit, "Archive is too large")
            target = (destination / item.name).resolve()
            require(not item.name.startswith("/") and target.is_relative_to(destination), "Unsafe archive path")
            require(item.isfile() or item.isdir(), "Archive links and special files are forbidden")
        # All entries are validated before writing anything. Only regular files
        # and directories are accepted; no links can escape the destination.
        source.extractall(destination, members=members, filter="data")


def aws(*args, timeout=180):
    # Never log CLI arguments or raw output: SSM commands and backup contents can
    # contain private identity. Callers print only deliberately selected fields.
    result = subprocess.run(["aws", *args, "--output", "json", "--no-cli-pager"],
                            capture_output=True, text=True, timeout=timeout)
    require(result.returncode == 0, "AWS " + " ".join(args[:2]) + " failed; inspect restricted AWS audit logs")
    return json.loads(result.stdout or "{}")


def validate_config(config):
    allowed = {"environment", "accountId", "region", "blocksBucket", "backupsBucket", "artifactsBucket",
               "originHost", "apiHost", "gatewayHost", "hostedZoneId", "acmeEmail", "instanceId"}
    require(not set(config).difference(allowed), "Unknown config field; credentials do not belong in deployment config")
    require(config.get("environment") in ("staging", "prod"), "Invalid environment")
    require(matches(r"\d{12}", config.get("accountId")), "accountId must be explicit")
    require(matches(r"[a-z]{2}-[a-z]+-\d", config.get("region")), "Invalid region")
    for key in ("blocksBucket", "backupsBucket", "artifactsBucket"):
        require(matches(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", config.get(key)), "Invalid " + key)
    require(len({config[k] for k in ("blocksBucket", "backupsBucket", "artifactsBucket")}) == 3,
            "Block, backup and artifact buckets must be separate")
    for key in ("originHost", "apiHost", "gatewayHost"):
        require(matches(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}", config.get(key)), "Invalid " + key)
        require(config[key] not in PROD_HOSTS, "New stacks must use dedicated candidate hostnames")
    require(len({config[k] for k in ("originHost", "apiHost", "gatewayHost")}) == 3, "Hostnames must be distinct")
    require(matches(r"Z[A-Z0-9]+", config.get("hostedZoneId")), "Invalid hostedZoneId")
    require(matches(r"[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+", config.get("acmeEmail")), "Invalid acmeEmail")
    if "instanceId" in config:
        require(matches(r"i-[a-f0-9]{17}", config["instanceId"]), "Invalid instanceId")
        require(config["instanceId"] != PROD_INSTANCE, "The existing production instance is not managed by this tooling")
    require(PROD_BUCKET not in {config[k] for k in ("blocksBucket", "backupsBucket", "artifactsBucket")},
            "Production data requires a separately reviewed adoption; candidates must use isolated buckets")
    return config


def environment_policy(environment):
    return json.loads((ROOT / "environments" / (environment + ".json")).read_text())


def mutation_guard(config, sha, environ):
    validate_config(config)
    policy = environment_policy(config["environment"])
    require(policy["changesEnabled"], "Production changes are disabled in the checked-in environment policy")
    require(matches(r"[a-f0-9]{40}", sha), "A full reviewed source SHA is required")
    branch = "main" if config["environment"] == "prod" else "1a-staging"
    require(environ.get("GITHUB_ACTIONS") == "true", "Mutations run only through GitHub Actions")
    require(environ.get("GITHUB_REPOSITORY") == "6529-Collections/6529seize-backend", "Unexpected repository")
    require(environ.get("GITHUB_REF") == "refs/heads/" + branch, "Wrong environment branch")
    require(environ.get("GITHUB_SHA") == sha, "Dispatch SHA does not match reviewed source SHA")
    return policy
