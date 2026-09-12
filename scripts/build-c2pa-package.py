"""Reproduce the narrowly patched C2PA npm archive from a pinned upstream release.

No upstream code is executed. The published SDK and Rust sources retain their
original bytes; only installation wiring changes. Native code is installed from
separately pinned upstream release assets, never from an unchecked bundled file.
"""

import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "c2pa-node"
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_CONTENT = 80 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def read_upstream(metadata, local_path):
    if local_path:
        with Path(local_path).open("rb") as source:
            raw = source.read(MAX_ARCHIVE + 1)
    else:
        require(
            metadata["tarball"].startswith(
                "https://registry.npmjs.org/@contentauth/c2pa-node/-/"
            ),
            "Unexpected upstream registry URL",
        )
        with urllib.request.urlopen(metadata["tarball"], timeout=60) as response:
            raw = response.read(MAX_ARCHIVE + 1)
    require(len(raw) <= MAX_ARCHIVE, "Upstream archive exceeds size limit")
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode()
    require(integrity == metadata["integrity"], "Upstream npm integrity mismatch")
    files = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for entry in archive:
            name = PurePosixPath(entry.name)
            require(
                not name.is_absolute()
                and ".." not in name.parts
                and "\\" not in entry.name
                and name.parts[0] == "package",
                "Unexpected upstream member path",
            )
            if entry.isdir():
                continue
            require(entry.isfile(), "Upstream archive contains a non-regular file")
            require(entry.name not in files, "Duplicate upstream archive member")
            total += entry.size
            require(total <= MAX_CONTENT and len(files) < 4096, "Upstream content limit")
            files[entry.name] = archive.extractfile(entry).read()
    return files


def patched_files(original, metadata):
    files = dict(original)
    manifest = json.loads(files["package/package.json"])
    require(manifest["name"] == metadata["name"], "Unexpected upstream package name")
    require(manifest["version"] == metadata["version"], "Unexpected upstream version")
    require(
        manifest["dependencies"].pop("unzipper", None) == "^0.10.14",
        "Upstream unzipper dependency changed; review the patch",
    )
    replacement = metadata["replacement_dependency"]
    manifest["dependencies"][replacement["name"]] = replacement["version"]
    manifest["x-6529-patch"] = {
        "revision": metadata["patched_version"],
        "upstream_version": metadata["version"],
        "scope": "Installer only: yauzl extraction and pinned native assets",
    }
    require(
        manifest["scripts"]["postinstall"] == "node scripts/postinstall.cjs",
        "Upstream installer entry point changed",
    )
    files["package/package.json"] = json_bytes(manifest)
    for name in ("postinstall.cjs", "native-assets.json"):
        # Normalize the two authored text inputs for Windows and Linux checkouts.
        files["package/scripts/" + name] = (VENDOR / name).read_text(
            encoding="utf-8"
        ).encode("utf-8")
    files["package/6529-PATCH.md"] = (VENDOR / "README.md").read_text(
        encoding="utf-8"
    ).encode("utf-8")
    # A registry tarball may include the publisher's platform-specific binary.
    # The installer always installs the matching checksum-pinned release asset.
    omitted = sorted(name for name in files if name.endswith(".node"))
    for name in omitted:
        del files[name]
    allowed = {"package/package.json", "package/scripts/postinstall.cjs"}
    for name, content in original.items():
        if name not in allowed and name not in omitted:
            require(files[name] == content, "Unexpected SDK/Rust source modification")
    require("package/LICENSE" in files, "Upstream licence is missing")
    return files, omitted


def make_archive(files):
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name, content in sorted(files.items()):
                info = tarfile.TarInfo(name)
                info.size = len(content)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


def check_consumers(metadata, result, files):
    package = json.loads(files["package/package.json"])
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(result).digest()).decode()
    for relative, prefix in (("", ""), ("src/artworkDocumentationProcessor", "../../")):
        directory = ROOT / relative
        manifest = json.loads((directory / "package.json").read_text(encoding="utf-8"))
        lock = json.loads((directory / "package-lock.json").read_text(encoding="utf-8"))
        expected = f"file:{prefix}vendor/c2pa-node/c2pa-node-{metadata['patched_version']}.tgz"
        require(manifest["dependencies"][metadata["name"]] == expected, "Consumer archive reference differs")
        packages = lock["packages"]
        require(packages[""]["dependencies"][metadata["name"]] == expected, "Lockfile root reference differs")
        sdk_path = "node_modules/" + metadata["name"]
        sdk = packages[sdk_path]
        require(
            sdk["version"] == metadata["version"]
            and sdk["resolved"] == expected
            and sdk["integrity"] == integrity
            and sdk["dependencies"] == package["dependencies"],
            "C2PA lockfile identity, integrity or dependency graph differs",
        )
        replacement = metadata["replacement_dependency"]
        nested = sdk_path + "/node_modules/" + replacement["name"]
        dependency = packages.get(nested, packages.get("node_modules/" + replacement["name"]))
        require(
            dependency
            and dependency["version"] == replacement["version"]
            and dependency["integrity"] == replacement["integrity"],
            "Replacement ZIP dependency is not pinned to the reviewed package",
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--upstream-archive", help="Optional local npm archive; integrity is still checked")
    args = parser.parse_args()
    metadata = json.loads((VENDOR / "upstream.json").read_text(encoding="utf-8"))
    original = read_upstream(metadata, args.upstream_archive)
    files, omitted = patched_files(original, metadata)
    result = make_archive(files)
    target = VENDOR / f"c2pa-node-{metadata['patched_version']}.tgz"
    receipt = {
        "upstream_integrity": metadata["integrity"],
        "patched_archive_sha256": hashlib.sha256(result).hexdigest(),
        "patched_archive_size": len(result),
        "omitted_native_binaries": omitted,
        "files": {
            name: {
                "sha256": hashlib.sha256(content).hexdigest(),
                "size": len(content),
                "unchanged_upstream": original.get(name) == content,
            }
            for name, content in sorted(files.items())
        },
    }
    outputs = {
        target: result,
        VENDOR / "contents.json": json_bytes(receipt),
        VENDOR / "LICENSE": files["package/LICENSE"],
    }
    for path, content in outputs.items():
        if args.check:
            require(path.read_bytes() == content, f"Generated C2PA artifact differs: {path.name}")
        else:
            path.write_bytes(content)
    if args.check:
        check_consumers(metadata, result, files)
    print(
        f"C2PA package {'verified' if args.check else 'generated'}: "
        f"{len(files)} files, {len(result)} bytes; SDK sources unchanged; "
        f"omitted {len(omitted)} platform binaries"
    )


if __name__ == "__main__":
    main()
