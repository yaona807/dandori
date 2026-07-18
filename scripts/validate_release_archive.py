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
WINDOWS_FORBIDDEN_CHARACTERS = frozenset('<>:"\\|?*')
WINDOWS_RESERVED_BASENAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{number}" for number in range(1, 10)}
    | {f"LPT{number}" for number in range(1, 10)}
)
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


def _windows_portability_error(component: str) -> str | None:
    if component.endswith((" ", ".")):
        return "path components must not end with a space or period"
    forbidden = sorted(
        {character for character in component if character in WINDOWS_FORBIDDEN_CHARACTERS}
    )
    if forbidden:
        return f"path component contains Windows-forbidden characters: {forbidden}"
    if any(ord(character) < 32 for character in component):
        return "path component contains a Windows-forbidden control character"
    basename = component.split(".", 1)[0].upper()
    if basename in WINDOWS_RESERVED_BASENAMES:
        return f"Windows-reserved path component is forbidden: {component}"
    return None


def _portable_path_key(parts: list[str]) -> str:
    return "/".join(
        unicodedata.normalize("NFKC", component).casefold()
        for component in parts
    )


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
            portability_errors = [
                error
                for component in raw_parts
                if (error := _windows_portability_error(component)) is not None
            ]
            if portability_errors:
                errors.extend(f"non-portable ZIP entry name {name!r}: {error}" for error in portability_errors)
                continue
            portable_name = _portable_path_key(raw_parts)
            if portable_name in seen_portable_names:
                errors.append(f"portable-name collision is forbidden in release ZIP: {name}")
                continue
            seen_portable_names.add(portable_name)
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
