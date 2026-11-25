"""Validate a build-dmg result manifest against the shared schema rules."""

from __future__ import annotations

import json
import re

COMMIT_SHA = re.compile(r"^[0-9a-f]{40}$")
SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MODES = frozenset({"adhoc", "developer-id"})
FIELDS = ("dmg_name", "ref", "sha256", "signing_mode", "size_bytes", "version")


class ManifestError(ValueError):
    pass


def dmg_name(version: str) -> str:
    return f"Blowhorn-{version}-universal.dmg"


def parse_manifest(raw) -> dict:
    data = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
    if not isinstance(data, dict):
        raise ManifestError("manifest must be an object")
    if tuple(sorted(data)) != tuple(sorted(FIELDS)):
        raise ManifestError(f"manifest fields must be exactly {', '.join(FIELDS)}")
    version = data["version"]
    if not SEMVER.fullmatch(str(version)):
        raise ManifestError("manifest version is not a semver")
    if not COMMIT_SHA.fullmatch(str(data["ref"])):
        raise ManifestError("manifest ref must be a full 40-character commit SHA")
    if data["signing_mode"] not in MODES:
        raise ManifestError("manifest signing_mode must be adhoc or developer-id")
    if not SHA256.fullmatch(str(data["sha256"])):
        raise ManifestError("manifest sha256 must be 64 lowercase hex digits")
    size = data["size_bytes"]
    if not isinstance(size, int) or isinstance(size, bool) or size < 1:
        raise ManifestError("manifest size_bytes must be a positive integer")
    if data["dmg_name"] != dmg_name(version):
        raise ManifestError(f"manifest dmg_name must be {dmg_name(version)}")
    return data
