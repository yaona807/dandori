#!/usr/bin/env python3
"""Run the fixed DANDORI test suites and fail closed on incomplete execution."""

from __future__ import annotations

import os
import sys

_SCRIPT_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
if sys.path and os.path.abspath(sys.path[0]) == _SCRIPT_DIRECTORY:
    del sys.path[0]

import argparse
import importlib.util
import unittest
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]
TEST_SUITE_SPECS = (
    ("tests/test_validate_definitions.py", "ValidatorMutationTests"),
    ("tests/test_validate_release_archive.py", "ReleaseArchiveValidationTests"),
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allow-skips",
        action="store_true",
        help="Allow skipped tests for explicit local platform diagnostics only.",
    )
    return parser


def load_module(relative_path: str, index: int) -> ModuleType:
    path = ROOT / relative_path
    spec = importlib.util.spec_from_file_location(f"dandori_test_suite_{index}", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load required test module: {relative_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_suite() -> unittest.TestSuite:
    suite = unittest.TestSuite()
    for index, (relative_path, class_name) in enumerate(TEST_SUITE_SPECS):
        module = load_module(relative_path, index)
        test_class = getattr(module, class_name, None)
        if not isinstance(test_class, type) or not issubclass(test_class, unittest.TestCase):
            raise RuntimeError(
                f"required test class must inherit unittest.TestCase: {relative_path}:{class_name}"
            )
        suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(test_class))
    return suite


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        suite = build_suite()
    except Exception as exc:  # noqa: BLE001 - fail closed with a concise runner error
        print(f"DANDORI test execution failed: {exc}", file=sys.stderr)
        return 1

    result = unittest.TextTestRunner(verbosity=1).run(suite)
    if result.testsRun == 0:
        print("DANDORI test execution failed: no tests were executed.", file=sys.stderr)
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
