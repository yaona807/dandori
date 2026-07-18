from __future__ import annotations

import importlib.util
import stat
import sys
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "dandori_release_validator",
    ROOT / "scripts" / "validate_release_archive.py",
)
assert SPEC and SPEC.loader
release_validator = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = release_validator
SPEC.loader.exec_module(release_validator)


class ReleaseArchiveValidationTests(unittest.TestCase):
    def make_archive(self) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temporary = tempfile.TemporaryDirectory()
        archive_path = Path(temporary.name) / "dandori.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(ROOT.rglob("*")):
                if not path.is_file() or ".git" in path.parts or "__pycache__" in path.parts:
                    continue
                archive.write(path, path.relative_to(ROOT).as_posix())
        return temporary, archive_path

    def assert_invalid(self, archive_path: Path, needle: str) -> None:
        errors = release_validator.validate_release_archive(archive_path)
        self.assertTrue(errors, "expected release archive validation failure")
        self.assertTrue(any(needle in error for error in errors), "\n".join(errors))

    def test_release_archive_is_valid(self) -> None:
        temporary, archive_path = self.make_archive()
        with temporary:
            self.assertEqual([], release_validator.validate_release_archive(archive_path))

    def test_release_archive_rejects_path_traversal(self) -> None:
        temporary, archive_path = self.make_archive()
        with temporary:
            with zipfile.ZipFile(archive_path, "a") as archive:
                archive.writestr("../escape.txt", "escape")
            self.assert_invalid(archive_path, "unsafe ZIP entry path")

    def test_release_archive_rejects_absolute_path(self) -> None:
        temporary, archive_path = self.make_archive()
        with temporary:
            with zipfile.ZipFile(archive_path, "a") as archive:
                archive.writestr("/absolute.txt", "absolute")
            self.assert_invalid(archive_path, "unsafe ZIP entry path")

    def test_release_archive_rejects_backslash_path(self) -> None:
        temporary, archive_path = self.make_archive()
        with temporary:
            with zipfile.ZipFile(archive_path, "a") as archive:
                archive.writestr("scripts\\bad.py", "bad")
            self.assert_invalid(archive_path, "invalid ZIP entry name")

    def test_release_archive_rejects_dot_segment(self) -> None:
        temporary, archive_path = self.make_archive()
        with temporary:
            with zipfile.ZipFile(archive_path, "a") as archive:
                archive.writestr("scripts/./bad.py", "bad")
            self.assert_invalid(archive_path, "unsafe ZIP entry path")

    def test_release_archive_rejects_symlink(self) -> None:
        temporary, archive_path = self.make_archive()
        with temporary:
            info = zipfile.ZipInfo("scripts/external-link")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            with zipfile.ZipFile(archive_path, "a") as archive:
                archive.writestr(info, "../../external")
            self.assert_invalid(archive_path, "symlink is forbidden")

    def test_release_archive_rejects_generated_artifact(self) -> None:
        temporary, archive_path = self.make_archive()
        with temporary:
            with zipfile.ZipFile(archive_path, "a") as archive:
                archive.writestr("scripts/__pycache__/bad.pyc", "generated")
            self.assert_invalid(archive_path, "generated artifact is forbidden")

    def test_release_archive_rejects_missing_required_file(self) -> None:
        temporary, archive_path = self.make_archive()
        with temporary:
            rewritten = Path(temporary.name) / "missing.zip"
            with zipfile.ZipFile(archive_path) as source, zipfile.ZipFile(rewritten, "w") as target:
                for info in source.infolist():
                    if info.filename != "README.md":
                        target.writestr(info, source.read(info.filename))
            self.assert_invalid(rewritten, "missing required repository files")

    def test_release_archive_rejects_unexpected_top_level_entry(self) -> None:
        temporary, archive_path = self.make_archive()
        with temporary:
            with zipfile.ZipFile(archive_path, "a") as archive:
                archive.writestr("unexpected.txt", "unexpected")
            self.assert_invalid(archive_path, "unexpected top-level release entry")

    def test_release_archive_rejects_duplicate_entry(self) -> None:
        temporary, archive_path = self.make_archive()
        with temporary:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(archive_path, "a") as archive:
                    archive.writestr("README.md", "duplicate")
            self.assert_invalid(archive_path, "duplicate ZIP entry is forbidden")

    def test_release_archive_rejects_portable_name_collision(self) -> None:
        temporary, archive_path = self.make_archive()
        with temporary:
            with zipfile.ZipFile(archive_path, "a") as archive:
                archive.writestr("scripts/Validate_Definitions.py", "collision")
            self.assert_invalid(archive_path, "portable-name collision is forbidden")

    def test_release_archive_rejects_windows_reserved_names(self) -> None:
        for entry_name in ("assets/CON", "assets/con.txt", "assets/COM1.log", "assets/LPT9"):
            with self.subTest(entry=entry_name):
                temporary, archive_path = self.make_archive()
                with temporary:
                    with zipfile.ZipFile(archive_path, "a") as archive:
                        archive.writestr(entry_name, "reserved")
                    self.assert_invalid(archive_path, "Windows-reserved path component")

    def test_release_archive_rejects_nfkc_windows_reserved_names(self) -> None:
        for entry_name in (
            "assets/COM¹",
            "assets/COM².txt",
            "assets/COM³.log",
            "assets/LPT¹",
            "assets/LPT².txt",
            "assets/LPT³.log",
        ):
            with self.subTest(entry=entry_name):
                temporary, archive_path = self.make_archive()
                with temporary:
                    with zipfile.ZipFile(archive_path, "a") as archive:
                        archive.writestr(entry_name, "reserved")
                    self.assert_invalid(archive_path, "Windows-reserved path component")

    def test_release_archive_rejects_windows_forbidden_characters(self) -> None:
        for entry_name in ("assets/a:b", "assets/a?b", "assets/a|b", "assets/a\x1fb"):
            with self.subTest(entry=entry_name):
                temporary, archive_path = self.make_archive()
                with temporary:
                    with zipfile.ZipFile(archive_path, "a") as archive:
                        archive.writestr(entry_name, "forbidden")
                    self.assert_invalid(archive_path, "non-portable ZIP entry name")

    def test_release_archive_rejects_trailing_space_or_period(self) -> None:
        for entry_name in ("assets/name.", "assets/name "):
            with self.subTest(entry=entry_name):
                temporary, archive_path = self.make_archive()
                with temporary:
                    with zipfile.ZipFile(archive_path, "a") as archive:
                        archive.writestr(entry_name, "trailing")
                    self.assert_invalid(archive_path, "must not end with a space or period")

    def test_release_archive_rejects_nfkc_portable_name_collision(self) -> None:
        temporary, archive_path = self.make_archive()
        with temporary:
            with zipfile.ZipFile(archive_path, "a") as archive:
                archive.writestr("assets/Ａudit.txt", "collision")
                archive.writestr("assets/Audit.txt", "collision")
            self.assert_invalid(archive_path, "portable-name collision is forbidden")

    def test_release_archive_rejects_invalid_extracted_repository(self) -> None:
        temporary, archive_path = self.make_archive()
        with temporary:
            rewritten = Path(temporary.name) / "invalid.zip"
            with zipfile.ZipFile(archive_path) as source, zipfile.ZipFile(rewritten, "w") as target:
                for info in source.infolist():
                    data = source.read(info.filename)
                    if info.filename == ".copilot/agents/Orchestrator.agent.md":
                        data = data.replace(b"Missing permission is denied.", b"Missing permission is allowed.", 1)
                    target.writestr(info, data)
            self.assert_invalid(rewritten, "extracted release validation")


if __name__ == "__main__":
    unittest.main()
