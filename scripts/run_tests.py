#!/usr/bin/env python3
"""Run the DANDORI test suite and fail closed on skipped or missing tests."""

from __future__ import annotations

import argparse
import sys
import unittest
from pathlib import Path

DEFAULT_START_DIRECTORY = Path(__file__).resolve().parents[1] / "tests"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--start-directory",
        type=Path,
        default=DEFAULT_START_DIRECTORY,
        help="Directory used for unittest discovery.",
    )
    parser.add_argument(
        "--pattern",
        default="test_*.py",
        help="Filename pattern used for unittest discovery.",
    )
    parser.add_argument(
        "--allow-skips",
        action="store_true",
        help="Allow skipped tests for explicit local platform diagnostics only.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    suite = unittest.defaultTestLoader.discover(
        start_dir=str(arguments.start_directory),
        pattern=arguments.pattern,
    )
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    if result.testsRun == 0:
        print("DANDORI test execution failed: no tests were discovered.", file=sys.stderr)
        return 1
    if result.skipped and not arguments.allow_skips:
        print(
            f"DANDORI test execution failed: {len(result.skipped)} skipped test(s) are forbidden.",
            file=sys.stderr,
        )
        for test, reason in result.skipped:
            print(f"- {test}: {reason}", file=sys.stderr)
        return 1
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
