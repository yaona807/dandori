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
        "test_additional_workflow_is_rejected",
        "test_all_conformance_cases_are_required",
        "test_attempt_counter_uses_source_permission_pairs",
        "test_bundled_worker_policy_must_remain_in_strict_rules",
        "test_checkout_disables_persisted_credentials",
        "test_checkout_step_cannot_override_repository",
        "test_conflict_verification_uses_normal_policy",
        "test_conformance_expected_cannot_be_empty",
        "test_conformance_input_cannot_be_empty",
        "test_conformance_run_record_lists_every_case",
        "test_conformance_run_record_requires_dandori_revision",
        "test_dandori_coupling_format_variants_are_rejected",
        "test_docker_action_requires_digest",
        "test_execute_requires_active_criterion_reference",
        "test_execution_bypass_frontmatter_keys_are_rejected",
        "test_inline_workflow_action_requires_full_commit_sha",
        "test_local_github_actions_are_rejected",
        "test_missing_bundled_worker_definition_is_rejected",
        "test_new_conformance_case_requires_run_record_entry",
        "test_orchestrator_invariant_must_remain_in_its_required_section",
        "test_orchestrator_rejects_edit_tool",
        "test_pull_request_trigger_configuration_is_exact",
        "test_push_trigger_configuration_is_exact",
        "test_python_execution_inventory_rejects_nested_packages",
        "test_python_ignore_rules_are_required",
        "test_repository_is_valid",
        "test_repository_symlinks_are_rejected",
        "test_required_mutation_test_bodies_cannot_be_empty",
        "test_required_mutation_test_class_cannot_be_skipped",
        "test_required_mutation_test_helpers_cannot_be_empty",
        "test_required_mutation_test_method_cannot_be_skipped",
        "test_required_mutation_test_methods_cannot_be_removed",
        "test_required_release_test_bodies_cannot_be_empty",
        "test_required_release_test_class_cannot_be_skipped",
        "test_required_release_test_helpers_cannot_be_empty",
        "test_required_release_test_methods_cannot_be_removed",
        "test_required_repository_files_cannot_be_removed",
        "test_required_test_classes_must_inherit_unittest_testcase",
        "test_required_test_methods_must_be_synchronous",
        "test_required_test_modules_cannot_define_load_tests",
        "test_required_validation_commands_must_stay_in_validate_job",
        "test_required_validation_step_cannot_be_conditionally_skipped",
        "test_required_validation_step_cannot_ignore_failures",
        "test_required_validation_step_rejects_shell_override",
        "test_reusable_workflow_requires_full_commit_sha",
        "test_scripts_inventory_rejects_module_shadowing",
        "test_target_usage_requires_canonical_typed_identity",
        "test_test_runner_allow_skips_defaults_to_false",
        "test_test_runner_exit_status_tracks_test_result",
        "test_test_runner_rejects_discovery_configuration",
        "test_test_runner_rejects_duplicate_test_ids",
        "test_test_runner_requires_all_required_test_ids",
        "test_test_runner_skip_guard_is_required",
        "test_test_runner_suite_inventory_is_fixed",
        "test_tests_inventory_rejects_additional_test_module",
        "test_tracked_python_generated_artifact_is_rejected",
        "test_unchanged_contract_entities_preserve_ids",
        "test_validate_job_cannot_be_conditionally_skipped",
        "test_validate_job_cannot_depend_on_another_job",
        "test_validate_job_cannot_ignore_failures",
        "test_validate_job_requires_github_hosted_runner",
        "test_validate_job_requires_timeout",
        "test_validate_workflow_disables_python_bytecode",
        "test_validate_workflow_rejects_extra_steps",
        "test_validate_workflow_rejects_global_run_defaults",
        "test_validation_workflow_rejects_additional_job",
        "test_validation_workflow_rejects_path_filters",
        "test_validation_workflow_rejects_unapproved_trigger",
        "test_validation_workflow_requires_master_push_trigger",
        "test_validation_workflow_requires_mutation_test_command",
        "test_validation_workflow_requires_pull_request_trigger",
        "test_validation_workflow_requires_read_only_permissions",
        "test_validation_workflow_requires_release_archive_build",
        "test_validation_workflow_requires_release_archive_validation",
        "test_validation_workflow_requires_validator_command",
        "test_verification_execute_policy_is_required",
        "test_worker_rejects_agent_tool",
        "test_workflow_actions_require_full_commit_sha",
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
