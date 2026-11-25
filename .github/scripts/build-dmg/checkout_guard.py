"""Refuse a product checkout that materialized internal or signing paths."""

from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).resolve().parent
EXCLUDES = HERE / "excludes.txt"
SIGNING = "release/signing/"


def read_excludes(path: Path = EXCLUDES) -> list[str]:
    lines = []
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        lines.append(line if line.endswith("/") else f"{line}/")
    if not lines or lines[0] != SIGNING:
        raise SystemExit("excludes.txt must start with release/signing/")
    return lines


def parse_internal_paths(text: str) -> list[str]:
    paths = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        rel = line if line.endswith("/") else f"{line}/"
        as_path = Path(rel)
        if as_path.is_absolute() or ".." in as_path.parts:
            raise SystemExit("internal-paths.txt has an entry that is not a relative checkout path")
        paths.append(rel)
    return paths


def present_paths(product: Path, paths: list[str]) -> list[str]:
    found = []
    for rel in paths:
        candidate = product / rel.rstrip("/")
        if candidate.exists():
            found.append(rel)
    return found


def _remove_tree(path: Path) -> None:
    # Delete without listing children, so signing file names never reach a log.
    import shutil
    shutil.rmtree(path, ignore_errors=True)
    if path.is_file() or path.is_symlink():
        path.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    import sys

    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        print("usage: checkout_guard.py PRODUCT_DIR", file=sys.stderr)
        return 2
    product = Path(args[0]).resolve()
    if not product.is_dir():
        print(f"product checkout is missing: {product}", file=sys.stderr)
        return 1
    excludes = read_excludes()
    listed = list(excludes)
    internal = product / "release" / "internal-paths.txt"
    if internal.is_file():
        for path in parse_internal_paths(internal.read_text()):
            if path not in listed:
                listed.append(path)
    present = present_paths(product, listed)
    for rel in present:
        _remove_tree(product / rel.rstrip("/"))
    if SIGNING in present:
        print("refusing: release/signing/ was present in the product checkout and has been removed", file=sys.stderr)
        return 1
    if present:
        print(f"refusing: {len(present)} internal path(s) were present in the product checkout and have been removed", file=sys.stderr)
        return 1
    print("checkout guard: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
