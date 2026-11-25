"""For a developer-id build, require that the product commit is the one named
by desktop-vVERSION or refs/releases/desktop-vVERSION. That is the tag (or
temporary ref) make release pushes before it dispatches, so an arbitrary
branch tip cannot be signed."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

REPO = "blowhorn-ai/blowhorn"
API = f"https://api.github.com/repos/{REPO}/git/ref"


class RefError(ValueError):
    pass


def _get(url: str, token: str) -> dict | None:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "blowhorn-site-build-dmg",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise RefError(f"could not read product refs (HTTP {error.code})") from None


def peel(token: str, ref: str) -> str | None:
    data = _get(f"{API}/{ref}", token)
    if data is None:
        return None
    obj = data.get("object") or {}
    sha = obj.get("sha")
    typ = obj.get("type")
    if typ == "tag" and sha:
        tag = _get(f"https://api.github.com/repos/{REPO}/git/tags/{sha}", token)
        if not tag:
            raise RefError("could not peel the product tag object")
        sha = (tag.get("object") or {}).get("sha")
        typ = (tag.get("object") or {}).get("type")
    if typ != "commit" or not isinstance(sha, str) or len(sha) != 40:
        raise RefError("product ref did not peel to a commit")
    return sha


def require_signed_ref(ref: str, version: str, token: str, lookup=peel) -> str:
    names = [f"tags/desktop-v{version}", f"releases/desktop-v{version}"]
    seen = []
    for name in names:
        sha = lookup(token, name)
        if sha:
            seen.append(sha)
            if sha == ref:
                return name
    raise RefError(
        "developer-id builds need product tag desktop-v"
        + version
        + " or refs/releases/desktop-v"
        + version
        + " to point at the requested commit"
    )


def main(argv: list[str] | None = None) -> int:
    del argv  # env-driven
    ref = os.environ.get("IN_REF", "")
    version = os.environ.get("IN_VERSION", "")
    token = os.environ.get("GH_TOKEN") or os.environ.get("DMG_SOURCE_TOKEN") or ""
    if not token:
        print("developer-id builds need DMG_SOURCE_TOKEN to confirm the product ref", file=sys.stderr)
        return 1
    try:
        name = require_signed_ref(ref, version, token)
    except RefError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(f"signed ref: ok ({name})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
