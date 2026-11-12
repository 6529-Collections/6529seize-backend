"""Validation shared by offline tooling, the controller, and the managed host."""
import hashlib
import json
import os
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROD_BUCKET = "6529ipfs"
PROD_INSTANCE = "i-0012c6236ad1292e8"
PROD_HOSTS = {"ipfs.6529.io", "ipfs-origin.6529.io", "api-ipfs.6529.io", "ipfs-cache.6529.io", "media.6529.io"}
RECEIPT_PROTOCOL = "6529.ipfs.receipt.v1"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def valid_hostname(value):
    if not isinstance(value, str) or len(value) > 253:
        return False
    labels = value.split(".")
    return len(labels) >= 2 and len(labels[-1]) >= 2 and any(c.isalpha() for c in labels[-1]) and all(
        matches(r"[a-z0-9-]{1,63}", label) and not label.startswith("-") and not label.endswith("-")
        for label in labels)


def valid_email(value):
    if not isinstance(value, str) or len(value) > 254 or value.count("@") != 1:
        return False
    local, domain = value.split("@")
    return matches(r"[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}", local) and valid_hostname(domain.lower())


def digest(path, directory):
    resolved = Path(path).resolve()
    base = Path(directory).resolve()
    if not resolved.is_relative_to(base) or not resolved.is_file():
        raise ValueError("Hash input must be a regular file under its permitted directory")
    result = hashlib.sha256()
    with resolved.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def write_private(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            os.fchmod(handle.fileno(), 0o600)
            json.dump(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


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
    require(isinstance(config, dict), "Deployment config must be a JSON object")
    allowed = {"environment", "accountId", "region", "blocksBucket", "backupsBucket", "artifactsBucket",
               "originHost", "apiHost", "gatewayHost", "hostedZoneId", "acmeEmail", "instanceId"}
    require(not set(config).difference(allowed), "Unknown config field; credentials do not belong in deployment config")
    require(config.get("environment") == "prod", "IPFS supports only the prod environment")
    require(matches(r"\d{12}", config.get("accountId")), "accountId must be explicit")
    require(matches(r"[a-z]{2}-[a-z]+-\d", config.get("region")), "Invalid region")
    for key in ("blocksBucket", "backupsBucket", "artifactsBucket"):
        require(matches(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", config.get(key)), "Invalid " + key)
    require(len({config[k] for k in ("blocksBucket", "backupsBucket", "artifactsBucket")}) == 3,
            "Block, backup and artifact buckets must be separate")
    for key in ("originHost", "apiHost", "gatewayHost"):
        require(valid_hostname(config.get(key)), "Invalid " + key)
        require(config[key] not in PROD_HOSTS, "New stacks must use dedicated candidate hostnames")
    require(len({config[k] for k in ("originHost", "apiHost", "gatewayHost")}) == 3, "Hostnames must be distinct")
    require(matches(r"Z[A-Z0-9]+", config.get("hostedZoneId")), "Invalid hostedZoneId")
    require(valid_email(config.get("acmeEmail")), "Invalid acmeEmail")
    if "instanceId" in config:
        require(matches(r"i-[a-f0-9]{17}", config["instanceId"]), "Invalid instanceId")
        require(config["instanceId"] != PROD_INSTANCE, "The existing production instance is not managed by this tooling")
    require(PROD_BUCKET not in {config[k] for k in ("blocksBucket", "backupsBucket", "artifactsBucket")},
            "Production data requires a separately reviewed adoption; candidates must use isolated buckets")
    return config


def environment_policy(environment):
    return json.loads((ROOT / "environments" / (environment + ".json")).read_text())


def source_guard(config, sha, environ):
    validate_config(config)
    source_identity_guard(sha, environ)


def source_identity_guard(sha, environ):
    """Shared source check, including operations that do not use candidate config."""
    require(matches(r"[a-f0-9]{40}", sha), "A full reviewed source SHA is required")
    require(environ.get("GITHUB_ACTIONS") == "true", "Mutations run only through GitHub Actions")
    require(environ.get("GITHUB_REPOSITORY") == "6529-Collections/6529seize-backend", "Unexpected repository")
    require(environ.get("GITHUB_REF") == "refs/heads/main", "IPFS deployments require main")
    require(environ.get("GITHUB_SHA") == sha, "Dispatch SHA does not match reviewed source SHA")


def mutation_guard(config, sha, environ):
    source_guard(config, sha, environ)
    policy = environment_policy(config["environment"])
    require(policy["changesEnabled"], "Production changes are disabled in the checked-in environment policy")
    return policy


def runtime_mutation_guard(sha, environ):
    """Authorize the production runtime path without contacting AWS."""
    source_identity_guard(sha, environ)
    policy = environment_policy('prod')
    require(policy['changesEnabled'], 'Production runtime changes are disabled')
    require(not policy['adoptionEnabled'], 'Ownership import must remain disabled')
    return policy
