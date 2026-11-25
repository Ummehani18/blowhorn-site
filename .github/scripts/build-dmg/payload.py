"""Validate a build-dmg dispatch payload against the shared schema rules."""

from __future__ import annotations

import json
import re
from pathlib import Path

COMMIT_SHA = re.compile(r"^[0-9a-f]{40}$")
SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
MODES = frozenset({"adhoc", "developer-id"})
EVENT = "build-dmg"
SCHEMA = Path(__file__).resolve().parents[2] / "schemas" / "build-dmg-dispatch.schema.json"


class PayloadError(ValueError):
    pass


def parse_payload(raw) -> dict:
    data = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
    if not isinstance(data, dict):
        raise PayloadError("payload must be an object")
    if set(data) != {"event_type", "client_payload"}:
        raise PayloadError("payload fields must be exactly event_type and client_payload")
    if data.get("event_type") != EVENT:
        raise PayloadError("event_type must be build-dmg")
    payload = data.get("client_payload")
    if not isinstance(payload, dict):
        raise PayloadError("client_payload must be an object")
    if set(payload) != {"ref", "version", "mode"}:
        raise PayloadError("client_payload fields must be exactly ref, version and mode")
    if not COMMIT_SHA.fullmatch(str(payload.get("ref", ""))):
        raise PayloadError("ref must be a full 40-character commit SHA")
    if not SEMVER.fullmatch(str(payload.get("version", ""))):
        raise PayloadError("version must be X.Y.Z (optionally -suffix), with no leading v")
    if payload.get("mode") not in MODES:
        raise PayloadError("mode must be adhoc or developer-id")
    return {"event_type": EVENT, "client_payload": dict(payload)}


def parse_inputs(ref: str, version: str, mode: str) -> dict:
    return parse_payload({"event_type": EVENT, "client_payload": {"ref": ref, "version": version, "mode": mode}})
