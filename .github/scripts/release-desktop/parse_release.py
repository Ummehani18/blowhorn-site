"""Classify a published blowhorn-site release tag against the desktop-release schema.

The public desktop tag is vX.Y.Z (optional prerelease suffix). axi-v* releases
are ignored so an axi publish does not fail this workflow. Any other tag is
rejected so a mistyped desktop tag is not silently skipped.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMA_PATH = HERE.parent.parent / "schemas" / "desktop-release-published.schema.json"
# Other product lines published from this repository. Prefixes only; a typo
# that merely looks similar still goes through the schema and is rejected.
SKIP_PREFIXES = ("axi-v",)
# Captured from the schema so the regex and the schema file cannot drift:
# tests compare this to the schema's tag_name.pattern.
TAG_PATTERN = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")


class ReleaseTagError(ValueError):
    pass


def load_schema_pattern(path: Path = SCHEMA_PATH) -> str:
    schema = json.loads(path.read_text(encoding="utf-8"))
    pattern = schema["properties"]["tag_name"]["pattern"]
    if pattern != TAG_PATTERN.pattern:
        raise ReleaseTagError("desktop-release schema tag_name.pattern does not match parse_release.TAG_PATTERN")
    return pattern


def version_from_tag(tag: str) -> str:
    if not TAG_PATTERN.fullmatch(tag):
        raise ReleaseTagError(f"tag {tag!r} is not a public desktop release tag (vX.Y.Z)")
    return tag[1:]


def classify_tag(tag: str) -> dict:
    """Return {decision, tag, version?, reason} for a published tag_name."""
    name = str(tag or "")
    if not name:
        raise ReleaseTagError("tag_name is empty")
    if any(name.startswith(prefix) for prefix in SKIP_PREFIXES):
        return {
            "decision": "skip",
            "tag": name,
            "reason": "not a desktop release (known prefix for another product line)",
        }
    if TAG_PATTERN.fullmatch(name):
        return {"decision": "accept", "tag": name, "version": version_from_tag(name)}
    hint = ""
    if name.startswith("desktop-v"):
        hint = " The public site tag is vX.Y.Z; desktop-vX.Y.Z is the private product tag."
    raise ReleaseTagError(
        f"tag {name!r} is not a public desktop release tag (expected vX.Y.Z, optional prerelease suffix).{hint}"
    )


def parse_event(event: dict) -> dict:
    release = event.get("release") if isinstance(event, dict) else None
    if not isinstance(release, dict):
        raise ReleaseTagError("event is missing release")
    return classify_tag(release.get("tag_name", ""))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event", type=Path, help="path to the GitHub event JSON (release published)")
    parser.add_argument("--tag", help="tag_name to classify, instead of --event")
    parser.add_argument("--output", type=Path, help="optional GitHub Actions output file")
    args = parser.parse_args(argv)

    load_schema_pattern()
    try:
        if args.tag is not None:
            result = classify_tag(args.tag)
        elif args.event is not None:
            result = parse_event(json.loads(args.event.read_text(encoding="utf-8")))
        else:
            parser.error("pass --tag or --event")
    except ReleaseTagError as error:
        print(str(error), file=sys.stderr)
        return 1

    print(f"desktop-release: {result['decision']} {result['tag']}"
          + (f" version {result['version']}" if "version" in result else ""))
    if args.output:
        with args.output.open("a", encoding="utf-8") as handle:
            handle.write(f"decision={result['decision']}\n")
            handle.write(f"tag={result['tag']}\n")
            if "version" in result:
                handle.write(f"version={result['version']}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
