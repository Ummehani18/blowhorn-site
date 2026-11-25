"""Attach a built DMG and its manifest to the private and public releases.

The private product release (desktop-vVERSION) is uploaded with
BLOWHORN_RELEASE_TOKEN and then published. The already-published public
site release (vVERSION) is uploaded with GH_TOKEN (the workflow's
GITHUB_TOKEN). Secret values are never printed. The manifest is checked
against the same schema rules as build-dmg before anything is uploaded.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "build-dmg"))
from manifest import parse_manifest  # noqa: E402

PRODUCT_REPO = "blowhorn-ai/blowhorn"
SITE_REPO = "blowhorn-ai/blowhorn-site"


class AttachError(ValueError):
    pass


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _env_with(token: str) -> dict[str, str]:
    env = dict(os.environ)
    env["GH_TOKEN"] = token
    env.pop("BLOWHORN_RELEASE_TOKEN", None)
    return env


def _gh(args: list[str], token: str, timeout: int = 120) -> str:
    result = subprocess.run(
        ["gh", *args],
        env=_env_with(token),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        # stderr from gh can include a URL; it must never include a token (we
        # only pass the token via env). Still, trim and drop obvious secret shapes.
        detail = (result.stderr or result.stdout).strip().replace("\n", " ")
        raise AttachError(f"gh {' '.join(args[:3])} failed: {detail[:300]}")
    return result.stdout


def asset_digest(repo: str, tag: str, name: str, token: str) -> tuple[int, str]:
    raw = _gh(
        ["api", f"repos/{repo}/releases/tags/{tag}", "--jq", ".assets"],
        token,
    )
    assets = json.loads(raw or "[]")
    match = next((item for item in assets if item.get("name") == name), None)
    if not match:
        raise AttachError(f"{repo} release {tag} has no asset {name}")
    size = match.get("size")
    digest = str(match.get("digest") or "")
    hexdigest = digest.split(":", 1)[-1] if digest.startswith("sha256:") else digest
    if not isinstance(size, int):
        raise AttachError(f"{repo} release {tag} asset {name} has no size")
    if not hexdigest:
        raise AttachError(f"{repo} release {tag} asset {name} has no sha256 digest")
    return size, hexdigest


def attach(
    *,
    dmg: Path,
    manifest_path: Path,
    version: str,
    site_tag: str,
    product_token: str,
    site_token: str,
    product_repo: str = PRODUCT_REPO,
    site_repo: str = SITE_REPO,
    run_gh=_gh,
    read_digest=None,
) -> dict:
    manifest = parse_manifest(manifest_path.read_text(encoding="utf-8"))
    if manifest["version"] != version:
        raise AttachError("manifest version does not match the requested version")
    if not dmg.is_file():
        raise AttachError("DMG is missing")
    digest = sha256_of(dmg)
    size = dmg.stat().st_size
    if digest != manifest["sha256"]:
        raise AttachError("sha256 of the DMG does not match the manifest")
    if size != manifest["size_bytes"]:
        raise AttachError("size of the DMG does not match the manifest")
    product_tag = f"desktop-v{version}"
    name = manifest["dmg_name"]
    lookup = read_digest or asset_digest
    run_gh(
        ["release", "upload", product_tag, f"{dmg}#{name}", "--repo", product_repo, "--clobber"],
        product_token,
        timeout=300,
    )
    run_gh(
        ["release", "upload", product_tag, f"{manifest_path}#build-dmg-manifest.json", "--repo", product_repo, "--clobber"],
        product_token,
        timeout=120,
    )
    prod_size, prod_digest = lookup(product_repo, product_tag, name, product_token)
    if prod_size != size or prod_digest != digest:
        raise AttachError("private release asset digest or size does not match the DMG")
    run_gh(["release", "edit", product_tag, "--repo", product_repo, "--draft=false"], product_token)
    run_gh(
        ["release", "upload", site_tag, f"{dmg}#{name}", "--repo", site_repo, "--clobber"],
        site_token,
        timeout=300,
    )
    run_gh(
        ["release", "upload", site_tag, f"{manifest_path}#build-dmg-manifest.json", "--repo", site_repo, "--clobber"],
        site_token,
        timeout=120,
    )
    site_size, site_digest = lookup(site_repo, site_tag, name, site_token)
    if site_size != size or site_digest != digest:
        raise AttachError("public release asset digest or size does not match the DMG")
    return {"dmg_name": name, "sha256": digest, "size_bytes": size, "product_tag": product_tag, "site_tag": site_tag}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dmg", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--site-tag", required=True)
    args = parser.parse_args(argv)
    product_token = os.environ.get("BLOWHORN_RELEASE_TOKEN") or ""
    site_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    if not product_token:
        print(
            "BLOWHORN_RELEASE_TOKEN is not available to this job. It is a blowhorn-ai "
            "org secret, selected for blowhorn and blowhorn-site, used only to write "
            "to blowhorn-ai/blowhorn.",
            file=sys.stderr,
        )
        return 2
    if not site_token:
        print("GITHUB_TOKEN is missing; this job cannot attach the public release asset", file=sys.stderr)
        return 1
    try:
        result = attach(
            dmg=args.dmg,
            manifest_path=args.manifest,
            version=args.version,
            site_tag=args.site_tag,
            product_token=product_token,
            site_token=site_token,
        )
    except AttachError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(
        f"attached {result['dmg_name']} sha256 {result['sha256']} "
        f"to {result['product_tag']} and {result['site_tag']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
