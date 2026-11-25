"""Start cut-desktop-release.yml on master. Never pass a tag ref.

The macos-dmg-signing environment is restricted to master, and a
release-published run's github.ref is the tag. This helper always
dispatches with --ref master so the signed job and the product write
run under master-pinned workflow files.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

WORKFLOW = "cut-desktop-release.yml"
REF = "master"


class DispatchError(ValueError):
    pass


def dispatch_args(version: str, site_tag: str, publisher: str = "") -> list[str]:
    if not version or version.startswith("v"):
        raise DispatchError("version must be X.Y.Z with no leading v")
    if not site_tag.startswith("v"):
        raise DispatchError("site_tag must be the public vX.Y.Z tag")
    args = [
        "workflow",
        "run",
        WORKFLOW,
        "--ref",
        REF,
        "-f",
        f"version={version}",
        "-f",
        f"site_tag={site_tag}",
    ]
    if publisher:
        args.extend(["-f", f"publisher={publisher}"])
    return args


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--site-tag", required=True)
    parser.add_argument("--publisher", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        command = ["gh", *dispatch_args(args.version, args.site_tag, args.publisher)]
    except DispatchError as error:
        print(str(error), file=sys.stderr)
        return 1
    if args.dry_run:
        print("would run: gh " + " ".join(command[1:]))
        return 0
    result = subprocess.run(command, check=False)
    if result.returncode != 0:
        print("failed to dispatch cut-desktop-release.yml on master", file=sys.stderr)
        return result.returncode
    print(f"dispatched {WORKFLOW} on {REF} for {args.site_tag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
