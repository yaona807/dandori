#!/usr/bin/env python3
"""Validate a DANDORI release ZIP before distribution."""

from __future__ import annotations

import stat
import sys
import tempfile
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath

from validate_definitions import (
    FORBIDDEN_TRACKED_FILENAMES,
    FORBIDDEN_TRACKED_PATH_PARTS,
    FORBIDDEN_TRACKED_SUFFIXES,
    REQUIRED_REPOSITORY_FILES,
    validate_repository,
)

MAX_RELEASE_ENTRIES = 500
MAX_RELEASE_UNCOMPRESSED_BYTES = 25_000_000
ALLOWED_TOP_LEVEL_ENTRIES = frozenset(
    {
        ".copilot",
        ".github",
        ".gitignore",
        "LICENSE",
        "README.md",
        "README_ja.md",
        "assets",
        "scripts",
        "tests",
    }
)


def _is_forbidden_generated_path(path: PurePosixPath) -> bool:
    return (
        bool(FORBIDDEN_TRACKED_PATH_PARTS.intersection(path.parts))
        or path.name in FORBIDDEN_TRACKED_FILENAMES
        or path.suffix.lower() in FORBIDDEN_TRACKED_SUFFIXES
    )


def _entry_kind(info: zipfile.ZipInfo) -> int:
    return stat.S_IFMT(info.external_attr >> 16)


def validate_release_archive(archive_path: Path) -> list[str]:
    errors: list[str] = []
    if not archive_path.is_file():
        return [f"release archive does not exist: {archive_path}"]

    try:
        archive = zipfile.ZipFile(archive_path)
    except (OSError, zipfile.BadZipFile) as exc:
        return [f"invalid release ZIP: {exc}"]

    with archive:
        infos = archive.infolist()
        if len(infos) > MAX_RELEASE_ENTRIES:
            errors.append(
                f"release archive contains too many entries: {len(infos)} > {MAX_RELEASE_ENTRIES}"
            )
        total_size = sum(info.file_size for info in infos)
        if total_size > MAX_RELEASE_UNCOMPRESSED_BYTES:
            errors.append(
                "release archive exceeds the uncompressed size limit: "
                f"{total_size} > {MAX_RELEASE_UNCOMPRESSED_BYTES}"
            )

        seen_names: set[str] = set()
        seen_portable_names: set[str] = set()
        regular_files: set[str] = set()
        for info in infos:
            name = info.filename
            if name in seen_names:
                errors.append(f"duplicate ZIP entry is forbidden: {name}")
                continue
            seen_names.add(name)
            portable_name = unicodedata.normalize("NFC", name).casefold()
            if portable_name in seen_portable_names:
                errors.append(f"portable-name collision is forbidden in release ZIP: {name}")
                continue
            seen_portable_names.add(portable_name)
            if not name or "\\" in name or "\x00" in name:
                errors.append(f"invalid ZIP entry name: {name!r}")
                continue
            raw_parts = name.split("/")
            if info.is_dir() and raw_parts and raw_parts[-1] == "":
                raw_parts = raw_parts[:-1]
            path = PurePosixPath(name)
            if (
                path.is_absolute()
                or not raw_parts
                or any(part in {"", ".", ".."} for part in raw_parts)
            ):
                errors.append(f"unsafe ZIP entry path: {name}")
                continue
            if path.parts[0] not in ALLOWED_TOP_LEVEL_ENTRIES:
                errors.append(f"unexpected top-level release entry: {path.parts[0]}")
            if _is_forbidden_generated_path(path):
                errors.append(f"generated artifact is forbidden in release ZIP: {name}")
            if info.flag_bits & 0x1:
                errors.append(f"encrypted ZIP entry is forbidden: {name}")

            kind = _entry_kind(info)
            is_directory = info.is_dir() or kind == stat.S_IFDIR
            if kind == stat.S_IFLNK:
                errors.append(f"symlink is forbidden in release ZIP: {name}")
            elif kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                errors.append(f"non-regular ZIP entry is forbidden: {name}")
            elif not is_directory:
                regular_files.add(name)

        missing = sorted(REQUIRED_REPOSITORY_FILES - regular_files)
        if missing:
            errors.append(f"release ZIP is missing required repository files: {missing}")

        if errors:
            return errors

        with tempfile.TemporaryDirectory() as temporary_directory:
            extraction_root = Path(temporary_directory)
            archive.extractall(extraction_root)
            repository_result = validate_repository(extraction_root)
            errors.extend(
                f"extracted release validation: {error}"
                for error in repository_result.errors
            )
    return errors


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    if len(arguments) != 1:
        print("usage: validate_release_archive.py <release.zip>", file=sys.stderr)
        return 2
    errors = validate_release_archive(Path(arguments[0]))
    if errors:
        print("DANDORI release archive validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("DANDORI release archive validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
