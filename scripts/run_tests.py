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
import subprocess
import unittest
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]
TEST_SUITE_SPECS = (
    ("tests/test_validate_definitions.py", "ValidatorMutationTests"),
    ("tests/test_validate_release_archive.py", "ReleaseArchiveValidationTests"),
)
REQUIRED_TEST_METHODS = {
    "ValidatorMutationTests": (
        "test_repository_is_valid",
        "test_missing_worker_definition",
        "test_old_workers_are_not_bundled",
        "test_parent_cannot_gain_edit_tool",
        "test_approval_boundary_marker_is_required",
        "test_reviewer_cannot_edit_or_mutate_github",
        "test_reviewer_requires_fixed_runner",
        "test_executor_requires_edit_tool",
        "test_agent_bundle_drift",
        "test_skill_bundle_drift",
        "test_missing_scoped_hook",
        "test_symlink_is_rejected",
        "test_missing_readme_is_rejected",
        "test_ci_validation_required",
        "test_reviewer_declares_code_review_skill",
        "test_ci_write_permissions_are_rejected",
        "test_ci_unpinned_action_is_rejected",
        "test_ci_target_event_is_rejected",
        "test_ci_shell_injection_is_rejected",
        "test_replaced_hook_command_is_rejected",
        "test_local_target_is_rejected",
        "test_local_tool_alias_is_rejected",
        "test_orchestrator_reflection_skill_cannot_be_removed",
        "test_reflection_skill_must_exist",
        "test_reflection_skill_cannot_grant_tools",
        "test_reflection_skill_bundle_drift",
        "test_copilot_agents_are_distributed_without_transformation",
        "test_parent_cannot_drop_workaround_tool_union",
    ),
    "ReleaseArchiveValidationTests": (
        "test_release_archive_is_valid",
        "test_release_archive_rejects_absolute_path",
        "test_release_archive_rejects_backslash_path",
        "test_release_archive_rejects_dot_segment",
        "test_release_archive_rejects_duplicate_entry",
        "test_release_archive_rejects_generated_artifact",
        "test_release_archive_rejects_invalid_extracted_repository",
        "test_release_archive_rejects_missing_required_file",
        "test_release_archive_rejects_nfkc_portable_name_collision",
        "test_release_archive_rejects_nfkc_windows_reserved_names",
        "test_release_archive_rejects_path_traversal",
        "test_release_archive_rejects_portable_name_collision",
        "test_release_archive_rejects_symlink",
        "test_release_archive_rejects_trailing_space_or_period",
        "test_release_archive_rejects_unexpected_top_level_entry",
        "test_release_archive_rejects_windows_forbidden_characters",
        "test_release_archive_rejects_windows_reserved_names",
    ),
}


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


def iter_test_cases(suite: unittest.TestSuite) -> Iterator[unittest.TestCase]:
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from iter_test_cases(item)
        elif isinstance(item, unittest.TestCase):
            yield item
        else:
            raise RuntimeError(f"unsupported test suite item: {type(item).__name__}")


def validate_loaded_suite(suite: unittest.TestSuite) -> None:
    identities = [
        (test.__class__.__name__, test._testMethodName)
        for test in iter_test_cases(suite)
    ]
    if len(identities) != len(set(identities)):
        raise RuntimeError("duplicate test IDs are forbidden")
    required = {
        (class_name, method_name)
        for class_name, method_names in REQUIRED_TEST_METHODS.items()
        for method_name in method_names
    }
    missing = sorted(required - set(identities))
    if missing:
        raise RuntimeError(f"required test IDs were not loaded: {missing}")


def build_suite() -> unittest.TestSuite:
    suite = unittest.TestSuite()
    for index, (relative_path, class_name) in enumerate(TEST_SUITE_SPECS):
        module = load_module(relative_path, index)
        test_class = getattr(module, class_name, None)
        if not isinstance(test_class, type) or not issubclass(test_class, unittest.TestCase):
            raise RuntimeError(
                f"required test class must inherit unittest.TestCase: {relative_path}:{class_name}"
            )
        suite.addTests(unittest.TestLoader().loadTestsFromTestCase(test_class))
    validate_loaded_suite(suite)
    return suite


def run_command_runner_tests() -> bool:
    try:
        completed = subprocess.run(
            [
                "node",
                "--test",
                ".copilot/skills/command-runner/tests/runner.test.mjs",
                ".copilot/skills/command-runner/tests/gateway.test.mjs",
            ],
            cwd=ROOT,
            check=False,
        )
    except OSError as exc:
        print(f"DANDORI command-runner test execution failed: {exc}", file=sys.stderr)
        return False
    if completed.returncode != 0:
        print(
            f"DANDORI command-runner tests failed with exit code {completed.returncode}.",
            file=sys.stderr,
        )
        return False
    return True


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
    if result.wasSuccessful() and not run_command_runner_tests():
        return 1
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
