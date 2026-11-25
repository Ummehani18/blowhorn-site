#!/usr/bin/env python3
"""Tests for the published-release desktop cut: tag schema, maintainer check, attach, dispatch."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
import sys

sys.path.insert(0, str(HERE / "release-desktop"))
import attach_dmg  # noqa: E402
import dispatch_cut  # noqa: E402
import parse_release  # noqa: E402
import require_maintainer  # noqa: E402

REF = "0123456789abcdef0123456789abcdef01234567"
SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


class ParseReleaseTest(unittest.TestCase):
    def test_schema_pattern_matches_the_module(self):
        self.assertEqual(parse_release.load_schema_pattern(), parse_release.TAG_PATTERN.pattern)

    def test_accepts_a_public_desktop_tag(self):
        self.assertEqual(
            parse_release.classify_tag("v2.15.0"),
            {"decision": "accept", "tag": "v2.15.0", "version": "2.15.0"},
        )
        self.assertEqual(parse_release.classify_tag("v2.15.0-beta.1")["version"], "2.15.0-beta.1")

    def test_skips_an_axi_release(self):
        result = parse_release.classify_tag("axi-v1.2.3")
        self.assertEqual(result["decision"], "skip")
        self.assertNotIn("version", result)

    def test_rejects_the_private_product_tag_and_a_short_version(self):
        with self.assertRaisesRegex(parse_release.ReleaseTagError, "desktop-vX.Y.Z is the private product tag"):
            parse_release.classify_tag("desktop-v2.15.0")
        with self.assertRaises(parse_release.ReleaseTagError):
            parse_release.classify_tag("v2.15")
        with self.assertRaises(parse_release.ReleaseTagError):
            parse_release.classify_tag("2.15.0")

    def test_parse_event_reads_tag_name(self):
        result = parse_release.parse_event({"release": {"tag_name": "v2.15.0"}})
        self.assertEqual(result["version"], "2.15.0")

    def test_main_writes_github_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            status = parse_release.main(["--tag", "v2.15.0", "--output", str(out)])
            self.assertEqual(status, 0)
            self.assertIn("version=2.15.0", out.read_text())


class RequireMaintainerTest(unittest.TestCase):
    def test_accepts_write_maintain_and_admin(self):
        for permission in ("write", "maintain", "admin"):
            self.assertEqual(
                require_maintainer.require_maintainer("blowhorn-ai/blowhorn-site", "yi", "t", lookup=lambda *_: permission),
                permission,
            )

    def test_rejects_read_and_a_missing_login(self):
        with self.assertRaises(require_maintainer.MaintainerError):
            require_maintainer.require_maintainer("blowhorn-ai/blowhorn-site", "yi", "t", lookup=lambda *_: "read")
        with self.assertRaises(require_maintainer.MaintainerError):
            require_maintainer.require_maintainer("blowhorn-ai/blowhorn-site", "", "t")

    def test_http_errors_do_not_chain_the_token(self):
        with self.assertRaises(require_maintainer.MaintainerError) as caught:
            require_maintainer.read_permission("blowhorn-ai/blowhorn-site", "yi", "super-secret-token", opener=_raise_403)
        self.assertNotIn("super-secret-token", str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)


def _raise_403(request, timeout=30):
    raise require_maintainer.urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, None)


class DispatchCutTest(unittest.TestCase):
    def test_always_dispatches_on_master(self):
        args = dispatch_cut.dispatch_args("2.15.0", "v2.15.0", publisher="yi")
        self.assertEqual(args[0:5], ["workflow", "run", "cut-desktop-release.yml", "--ref", "master"])
        self.assertIn("version=2.15.0", args)
        self.assertIn("site_tag=v2.15.0", args)
        self.assertNotIn("--ref", args[5:])  # only the one master ref

    def test_refuses_a_leading_v_on_the_version(self):
        with self.assertRaises(dispatch_cut.DispatchError):
            dispatch_cut.dispatch_args("v2.15.0", "v2.15.0")


class AttachDmgTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.dmg = self.dir / "Blowhorn-2.15.0-universal.dmg"
        payload = b"dmg-bytes-\xff\x00 not utf-8"
        self.dmg.write_bytes(payload)
        self.digest = attach_dmg.sha256_of(self.dmg)
        self.manifest = self.dir / "build-dmg-manifest.json"
        self.manifest.write_text(json.dumps({
            "version": "2.15.0",
            "ref": REF,
            "signing_mode": "developer-id",
            "sha256": self.digest,
            "size_bytes": len(payload),
            "dmg_name": "Blowhorn-2.15.0-universal.dmg",
        }))
        self.uploads = []

    def tearDown(self):
        self.tmp.cleanup()

    def test_uploads_to_both_releases_and_publishes_the_private_draft(self):
        def run_gh(args, token, timeout=120):
            self.uploads.append((tuple(args), token))
            return ""

        def digest(repo, tag, name, token):
            self.assertEqual(name, "Blowhorn-2.15.0-universal.dmg")
            return (self.dmg.stat().st_size, self.digest)

        result = attach_dmg.attach(
            dmg=self.dmg,
            manifest_path=self.manifest,
            version="2.15.0",
            site_tag="v2.15.0",
            product_token="product-token",
            site_token="site-token",
            run_gh=run_gh,
            read_digest=digest,
        )
        self.assertEqual(result["product_tag"], "desktop-v2.15.0")
        commands = [args for args, _ in self.uploads]
        self.assertTrue(any(args[:3] == ("release", "upload", "desktop-v2.15.0") and "product-token" == token
                            for args, token in self.uploads))
        self.assertTrue(any(args[:3] == ("release", "upload", "v2.15.0") and token == "site-token"
                            for args, token in self.uploads))
        self.assertIn(("release", "edit", "desktop-v2.15.0", "--repo", "blowhorn-ai/blowhorn", "--draft=false"), commands)

    def test_refuses_a_manifest_mismatch(self):
        with self.assertRaises(attach_dmg.AttachError):
            attach_dmg.attach(
                dmg=self.dmg,
                manifest_path=self.manifest,
                version="9.9.9",
                site_tag="v9.9.9",
                product_token="p",
                site_token="s",
                run_gh=lambda *a, **k: "",
                read_digest=lambda *a, **k: (1, "x"),
            )


class WorkflowAuditTest(unittest.TestCase):
    def test_thin_workflow_has_no_write_or_signing_secrets(self):
        text = (ROOT / ".github" / "workflows" / "release-desktop.yml").read_text()
        self.assertIn("types: [published]", text)
        self.assertIn("ref: master", text)
        self.assertIn("dispatch_cut.py", text)
        self.assertNotIn("secrets.BLOWHORN_RELEASE_TOKEN", text)
        self.assertNotIn("secrets.DEVELOPER_ID_P12", text)
        self.assertNotIn("secrets.APPLE_API_KEY", text)
        self.assertNotIn("secrets: inherit", text)

    def test_cut_workflow_runs_on_master_and_scopes_the_write_token(self):
        text = (ROOT / ".github" / "workflows" / "cut-desktop-release.yml").read_text()
        self.assertIn("refs/heads/master", text)
        self.assertIn("BLOWHORN_RELEASE_TOKEN", text)
        self.assertIn("uses: ./.github/workflows/build-dmg.yml", text)
        # The called build-dmg job must not be passed the write token.
        self.assertNotIn("BLOWHORN_RELEASE_TOKEN: ${{ secrets.BLOWHORN_RELEASE_TOKEN }}", text.split("uses: ./.github/workflows/build-dmg.yml", 1)[1].split("publish:", 1)[0])


if __name__ == "__main__":
    unittest.main()
