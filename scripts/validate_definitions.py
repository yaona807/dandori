#!/usr/bin/env python3
"""Validate DANDORI agent, skill, documentation, and policy definitions."""

from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

DEFAULT_ROOT = Path(__file__).resolve().parents[1]
MAX_AGENT_BODY_CHARS = 30_000
MAX_SKILL_NAME_CHARS = 64
MAX_SKILL_DESCRIPTION_CHARS = 1_024
FULL_COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-fA-F]{40}$")
DOCKER_IMAGE_DIGEST_PATTERN = re.compile(r"^docker://[^@\s]+@sha256:[0-9a-fA-F]{64}$")
REQUIRED_REPOSITORY_FILES = frozenset(
    {
        ".gitignore",
        "LICENSE",
        "README.md",
        "README_ja.md",
        ".github/workflows/validate.yml",
        "scripts/validate_definitions.py",
        "scripts/validate_release_archive.py",
        "tests/conformance.md",
        "tests/test_validate_definitions.py",
        "tests/test_validate_release_archive.py",
    }
)
REQUIRED_WORKFLOW_COMMANDS = (
    "python scripts/validate_definitions.py",
    'python -m unittest discover -s tests -p "test_*.py"',
)
REQUIRED_WORKFLOW_INSTALL_COMMAND = "python -m pip install --disable-pip-version-check PyYAML==6.0.3"
REQUIRED_RELEASE_ARCHIVE_BUILD_COMMAND = "git archive --format=zip --output=dandori-release.zip HEAD"
REQUIRED_RELEASE_ARCHIVE_VALIDATION_COMMAND = "python scripts/validate_release_archive.py dandori-release.zip"
REQUIRED_WORKFLOW_PUSH_BRANCH = "master"
REQUIRED_WORKFLOW_PYTHON_VERSION = "3.12"
REQUIRED_WORKFLOW_RUNNER = "ubuntu-latest"
REQUIRED_WORKFLOW_TIMEOUT_MINUTES = 15
ALLOWED_WORKFLOW_FILES = frozenset({"validate.yml"})
ALLOWED_WORKFLOW_TRIGGERS = frozenset({"pull_request", "push"})
REQUIRED_CONFORMANCE_CASE_IDS = tuple(f"CONF-{number:03d}" for number in range(1, 14))
REQUIRED_GITIGNORE_MARKERS = frozenset(
    {
        "__pycache__/",
        "*.py[codz]",
        ".pytest_cache/",
        ".coverage",
        "htmlcov/",
    }
)
FORBIDDEN_TRACKED_PATH_PARTS = frozenset({"__pycache__", ".pytest_cache", "htmlcov"})
FORBIDDEN_TRACKED_FILENAMES = frozenset({".coverage"})
FORBIDDEN_TRACKED_SUFFIXES = frozenset({".pyc", ".pyo"})
REQUIRED_MUTATION_TEST_METHODS = frozenset(
    {
        "test_repository_is_valid",
        "test_orchestrator_rejects_edit_tool",
        "test_worker_rejects_agent_tool",
        "test_missing_bundled_worker_definition_is_rejected",
        "test_execution_bypass_frontmatter_keys_are_rejected",
        "test_dandori_coupling_format_variants_are_rejected",
        "test_orchestrator_invariant_must_remain_in_its_required_section",
        "test_bundled_worker_policy_must_remain_in_strict_rules",
        "test_workflow_actions_require_full_commit_sha",
        "test_inline_workflow_action_requires_full_commit_sha",
        "test_reusable_workflow_requires_full_commit_sha",
        "test_repository_symlinks_are_rejected",
        "test_verification_execute_policy_is_required",
        "test_attempt_counter_uses_source_permission_pairs",
        "test_unchanged_contract_entities_preserve_ids",
        "test_conflict_verification_uses_normal_policy",
        "test_execute_requires_active_criterion_reference",
        "test_target_usage_requires_canonical_typed_identity",
        "test_required_repository_files_cannot_be_removed",
        "test_validation_workflow_requires_validator_command",
        "test_validation_workflow_requires_mutation_test_command",
        "test_validation_workflow_requires_release_archive_build",
        "test_validation_workflow_requires_release_archive_validation",
        "test_validation_workflow_requires_pull_request_trigger",
        "test_validation_workflow_requires_master_push_trigger",
        "test_validate_job_cannot_be_conditionally_skipped",
        "test_validate_job_cannot_ignore_failures",
        "test_required_validation_commands_must_stay_in_validate_job",
        "test_required_validation_step_cannot_be_conditionally_skipped",
        "test_required_validation_step_cannot_ignore_failures",
        "test_validation_workflow_rejects_path_filters",
        "test_validate_job_cannot_depend_on_another_job",
        "test_validate_workflow_rejects_extra_steps",
        "test_required_validation_step_rejects_shell_override",
        "test_validate_workflow_rejects_global_run_defaults",
        "test_validate_job_requires_github_hosted_runner",
        "test_validation_workflow_requires_read_only_permissions",
        "test_checkout_step_cannot_override_repository",
        "test_docker_action_requires_digest",
        "test_all_conformance_cases_are_required",
        "test_conformance_run_record_lists_every_case",
        "test_conformance_run_record_requires_dandori_revision",
        "test_conformance_input_cannot_be_empty",
        "test_conformance_expected_cannot_be_empty",
        "test_required_mutation_test_methods_cannot_be_removed",
        "test_required_mutation_test_bodies_cannot_be_empty",
        "test_required_mutation_test_helpers_cannot_be_empty",
        "test_new_conformance_case_requires_run_record_entry",
        "test_python_ignore_rules_are_required",
        "test_validate_workflow_disables_python_bytecode",
        "test_tracked_python_generated_artifact_is_rejected",
        "test_validation_workflow_rejects_unapproved_trigger",
        "test_validation_workflow_rejects_additional_job",
        "test_additional_workflow_is_rejected",
        "test_local_github_actions_are_rejected",
        "test_checkout_disables_persisted_credentials",
        "test_validate_job_requires_timeout",
    }
)
BOUNDARY_ENFORCEMENT_POLICY = (
    "Use a tool only when its arguments and runtime behavior can enforce the assigned boundary. "
    "If a tool can operate only on a broader scope, do not call it; return `blocked` and identify the narrower capability required."
)

BUNDLED_WORKER_TOOLS: dict[str, set[str]] = {
    "BrowserQA": {"browser"},
    "PullRequestResearcher": {
        "GitHub.vscode-pull-request-github/activePullRequest",
        "GitHub.vscode-pull-request-github/openPullRequest",
        "GitHub.vscode-pull-request-github/pullRequestStatusChecks",
        "GitHub.vscode-pull-request-github/issue_fetch",
        "read/readFile",
    },
    "Researcher": {
        "search/codebase",
        "search/usages",
        "search/fileSearch",
        "search/textSearch",
        "search/listDirectory",
        "read/readFile",
        "read/problems",
        "web/fetch",
    },
    "Reviewer": {
        "search/codebase",
        "search/usages",
        "read/readFile",
        "read/problems",
    },
    "Writer": {
        "read/readFile",
        "edit/editFiles",
        "edit/createFile",
        "edit/createDirectory",
    },
}
BUNDLED_AGENT_NAMES = frozenset({"Orchestrator", *BUNDLED_WORKER_TOOLS})
BUNDLED_AGENT_MIN_BODY_CHARS = {
    "Orchestrator": 20_000,
    "BrowserQA": 1_000,
    "PullRequestResearcher": 1_200,
    "Researcher": 1_100,
    "Reviewer": 1_000,
    "Writer": 1_200,
}
BUNDLED_AGENT_FRONTMATTER_KEYS = frozenset(
    {
        "name",
        "description",
        "model",
        "target",
        "user-invocable",
        "disable-model-invocation",
        "tools",
        "agents",
    }
)
FORBIDDEN_AGENT_FRONTMATTER_KEYS = frozenset({"hooks", "handoffs", "mcp-servers"})

BUNDLED_WORKER_REQUIRED_SECTION_MARKERS: dict[str, dict[str, tuple[str, ...]]] = {
    "BrowserQA": {
        "## Delegated task contract": ("Treat the delegated request as the complete task boundary.",),
        "## Strict rules": (
            BOUNDARY_ENFORCEMENT_POLICY,
            "Do not modify files.",
            "Do not run terminal commands.",
            "Do not call another agent.",
            "Never submit, save, publish, send, delete, confirm a transaction, change settings, or mutate persistent data.",
            "Stop before an action when its persistence or side effects are unclear.",
        ),
    },
    "PullRequestResearcher": {
        "## Delegated task contract": ("Treat the delegated request as the complete task boundary.",),
        "## Strict rules": (
            BOUNDARY_ENFORCEMENT_POLICY,
            "Do not modify files.",
            "Do not run terminal commands.",
            "Do not call another agent.",
            "Do not approve, merge, close, or comment on PRs.",
            "Do not inspect additional diffs, files, comments, checks, threads, or linked resources based only on apparent relevance.",
        ),
    },
    "Researcher": {
        "## Delegated task contract": ("Treat the delegated request as the complete task boundary.",),
        "## Strict rules": (
            BOUNDARY_ENFORCEMENT_POLICY,
            "Do not modify files.",
            "Do not run terminal commands.",
            "Do not call another agent.",
            "Search only within the assigned observation boundary.",
            "Use `web` or external documents only when external research is explicitly included in the current request.",
        ),
    },
    "Reviewer": {
        "## Delegated task contract": ("Treat the delegated request as the complete task boundary.",),
        "## Strict rules": (
            BOUNDARY_ENFORCEMENT_POLICY,
            "Do not modify files.",
            "Do not run terminal commands.",
            "Do not call another agent.",
            "Do not expand beyond the delegated scope.",
        ),
    },
    "Writer": {
        "## Delegated task contract": ("Treat the delegated request as the complete task boundary.",),
        "## Strict rules": (
            BOUNDARY_ENFORCEMENT_POLICY,
            "Do not perform broad codebase investigation.",
            "Do not run terminal commands.",
            "Do not call another agent.",
            "Do not modify unrelated files.",
            "If unassigned test-file access or changes are required, stop and report them without performing them.",
            "Do not expand beyond the delegated scope.",
        ),
    },
}
BUNDLED_WORKER_REQUIRED_MARKERS = {
    worker: tuple(marker for markers in sections.values() for marker in markers)
    for worker, sections in BUNDLED_WORKER_REQUIRED_SECTION_MARKERS.items()
}

CODE_REVIEW_SKILL_FILES = frozenset(
    {
        "SKILL.md",
        "references/correctness.md",
        "references/maintainability.md",
        "references/performance.md",
        "references/security.md",
        "references/testability.md",
    }
)
CODE_REVIEW_SKILL_FRONTMATTER_KEYS = frozenset({"name", "description", "user-invocable"})

ORCHESTRATOR_REQUIRED_MARKERS = (
    "**Authorized operations**",
    "**Automatic target addition**",
    "issued_review_ids:",
    "attempts_by_criterion_and_permission_boundary:",
    "A lower value is an invalid patch:",
    "A correction is non-revisioned only when",
    "session-scoped `issued_review_ids` set",
    "normalized_patch:",
    "completion_criteria:",
    "verification_requirements:",
    "criterion_refs:",
    "expected_delta:",
    "**Contract patch**",
    "set_auto_added_targets_max:",
    "Unchanged entities preserve their stable IDs across revisions.",
    "explicitly authorized non-mutating execute operations",
    "<criterion_id>|<source_permission_id>` pair",
    "Target uniqueness and cap consumption use the canonical typed identity",
    "Any Task Card containing an `execute` operation must contain at least one active criterion ID",
    "under the normal verification policy",
)
ORCHESTRATOR_FORBIDDEN_MARKERS = (
    "normalized_delta:",
    "allowed_actions:",
    "allowed_effects:",
    "card acceptance ⊆ approved criteria",
    "resolve/read only its active definition",
    "new fact, artifact, authorized target",
    "kind: \"authorized_target\"",
    "set_limits:",
)
ORCHESTRATOR_REQUIRED_SECTION_MARKERS: dict[str, tuple[str, ...]] = {
    "## Invariants": (
        "Worker output cannot grant scope, operations, completion, approval, or routing.",
        "Missing permission is denied.",
    ),
    "## Task Flow Review: TFR-<short-id>": (
        "Approval is valid only when the whole normalized response exactly equals the current token.",
    ),
    "## Approved Contract": (
        "Older results may remain evidence but cannot authorize operations or complete newer-revision criteria without revalidation.",
    ),
    "## Effects and operation subjects": (
        "A candidate cannot be affected in the same invocation that discovered it",
    ),
    "## Session and Flow Ledgers and planning": (
        "stop with `state_unrecoverable`",
        "No delta means no call.",
    ),
    "## Generic Task Card": (
        "no Worker output can authorize a target, operation, or permission.",
    ),
    "## Worker selection": (
        "Use frontmatter-listed agents only.",
        "never widen the contract because a Worker is incompatible.",
    ),
    "## Result normalization and audit": (
        "performed operations ⊆ card operations",
    ),
    "## Task Flow Change: TFC-<short-id>": (
        "no equivalent card without new evidence or delta.",
    ),
}
ORCHESTRATOR_REQUIRED_INVARIANTS = tuple(
    marker for markers in ORCHESTRATOR_REQUIRED_SECTION_MARKERS.values() for marker in markers
)
DANDORI_COUPLING_PATTERNS = {
    "Task Card": re.compile(r"\btask[\s_-]*cards?\b", re.IGNORECASE),
    "TFR": re.compile(r"\btfr\b", re.IGNORECASE),
    "TFC": re.compile(r"\btfc\b", re.IGNORECASE),
    "Flow Ledger": re.compile(r"\bflow[\s_-]*ledgers?\b", re.IGNORECASE),
    "Approved Contract": re.compile(r"\bapproved[\s_-]*contracts?\b", re.IGNORECASE),
    "access.* protocol": re.compile(r"\baccess\.[A-Za-z_]", re.IGNORECASE),
    "scope.* protocol": re.compile(r"\bscope\.[A-Za-z_]", re.IGNORECASE),
    "target_boundary.* protocol": re.compile(r"\btarget_boundary\.[A-Za-z_]", re.IGNORECASE),
    "browser_interaction_policy.* protocol": re.compile(
        r"\bbrowser_interaction_policy\.[A-Za-z_]",
        re.IGNORECASE,
    ),
    "worker_response envelope": re.compile(r"\bworker_response\b", re.IGNORECASE),
    "suggested_next_capability routing": re.compile(r"\bsuggested_next_capability\b", re.IGNORECASE),
    "final routing": re.compile(r"\bfinal routing\b", re.IGNORECASE),
}

SKILL_WORKER_POLICY_PATTERNS = {
    "file modification policy": re.compile(r"\bDo not modify files\b", re.IGNORECASE),
    "agent invocation policy": re.compile(r"\bDo not call another agent\b", re.IGNORECASE),
    "routing policy": re.compile(r"\bDo not decide who should perform follow-up work\b", re.IGNORECASE),
    "worker handoff language": re.compile(r"\bReview handoff output should be\b", re.IGNORECASE),
}


class UniqueKeyLoader(yaml.SafeLoader):
    """Safe YAML loader that rejects duplicate keys and preserves YAML 1.2-style `on` keys."""


UniqueKeyLoader.yaml_implicit_resolvers = {
    key: list(resolvers)
    for key, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
for resolver_key, resolvers in UniqueKeyLoader.yaml_implicit_resolvers.items():
    UniqueKeyLoader.yaml_implicit_resolvers[resolver_key] = [
        (tag, pattern)
        for tag, pattern in resolvers
        if tag != "tag:yaml.org,2002:bool"
    ]
UniqueKeyLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:true|false)$", re.IGNORECASE),
    list("tTfF"),
)


def _construct_unique_mapping(
    loader: UniqueKeyLoader,
    node: yaml.MappingNode,
    deep: bool = False,
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"found duplicate key {key!r}",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_unique_mapping,
)


@dataclass
class ValidationResult:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


@dataclass(frozen=True)
class Definition:
    path: Path
    meta: dict[str, Any]
    body: str


class DefinitionError(ValueError):
    pass


def relative(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise DefinitionError("missing opening frontmatter delimiter")
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration as exc:
        raise DefinitionError("missing closing frontmatter delimiter") from exc
    raw = "\n".join(lines[1:end])
    data = yaml.load(raw, Loader=UniqueKeyLoader)
    if not isinstance(data, dict):
        raise DefinitionError("frontmatter must be a mapping")
    return data, "\n".join(lines[end + 1 :])


def normalize_tools(value: Any) -> list[str]:
    if isinstance(value, list):
        if not all(isinstance(item, str) and item.strip() for item in value):
            raise DefinitionError("tools list must contain non-empty strings")
        return [item.strip() for item in value]
    if isinstance(value, str):
        values = [item.strip() for item in value.split(",")]
        if not values or any(not item for item in values):
            raise DefinitionError("tools string must be a comma-separated list of non-empty names")
        return values
    raise DefinitionError("tools must be a YAML list or comma-separated string")


def validate_relative_links(path: Path, body: str, root: Path, result: ValidationResult) -> None:
    for target in re.findall(r"!?(?:\[[^\]]*\])\(([^)]+)\)", body):
        target = target.strip().split("#", 1)[0]
        if not target or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
            continue
        candidate = (path.parent / target).resolve()
        try:
            candidate.relative_to(root.resolve())
        except ValueError:
            result.errors.append(f"{relative(path, root)}: relative link escapes repository: {target}")
            continue
        if not candidate.exists():
            result.errors.append(f"{relative(path, root)}: missing relative link target: {target}")


def validate_section_markers(
    path: Path,
    body: str,
    required_sections: dict[str, tuple[str, ...]],
    root: Path,
    result: ValidationResult,
    definition_label: str,
) -> None:
    for heading, markers in required_sections.items():
        matches = list(re.finditer(rf"(?m)^{re.escape(heading)}\s*$", body))
        if not matches:
            result.errors.append(
                f"{relative(path, root)}: missing required {definition_label} section {heading!r}"
            )
            continue
        if len(matches) > 1:
            result.errors.append(
                f"{relative(path, root)}: duplicate required {definition_label} section {heading!r}"
            )
            continue
        section_start = matches[0].end()
        next_heading = re.search(r"(?m)^## ", body[section_start:])
        section_end = section_start + next_heading.start() if next_heading else len(body)
        section = body[section_start:section_end]
        for marker in markers:
            if marker not in section:
                result.errors.append(
                    f"{relative(path, root)}: missing required {definition_label} section marker "
                    f"{marker!r} in {heading!r}"
                )


def validate_repository_symlinks(root: Path, result: ValidationResult) -> None:
    """Reject symlinks so reviewed repository paths cannot resolve to external content."""

    for current_root, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
        current = Path(current_root)
        directory_names[:] = [name for name in directory_names if name != ".git"]
        for name in (*directory_names, *file_names):
            path = current / name
            if path.is_symlink():
                result.errors.append(f"repository symlinks are forbidden: {relative(path, root)}")


def validate_gitignore_policy(root: Path, result: ValidationResult) -> None:
    path = root / ".gitignore"
    if not path.is_file():
        return
    entries = {
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    missing = sorted(REQUIRED_GITIGNORE_MARKERS - entries)
    if missing:
        result.errors.append(
            f"{relative(path, root)}: missing required Python ignore patterns: {missing}"
        )


def _is_forbidden_generated_path(path_text: str) -> bool:
    path = Path(path_text)
    return (
        bool(FORBIDDEN_TRACKED_PATH_PARTS.intersection(path.parts))
        or path.name in FORBIDDEN_TRACKED_FILENAMES
        or path.suffix.lower() in FORBIDDEN_TRACKED_SUFFIXES
    )


def validate_tracked_generated_artifacts(root: Path, result: ValidationResult) -> None:
    git_metadata = root / ".git"
    if not git_metadata.exists():
        return
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        result.errors.append(f"unable to inspect tracked files with git: {exc}")
        return
    tracked = [entry for entry in completed.stdout.split("\0") if entry]
    forbidden = sorted(path for path in tracked if _is_forbidden_generated_path(path))
    if forbidden:
        result.errors.append(f"tracked generated artifacts are forbidden: {forbidden}")


def validate_required_repository_files(root: Path, result: ValidationResult) -> None:
    for relative_path in sorted(REQUIRED_REPOSITORY_FILES):
        path = root / relative_path
        if not path.is_file():
            result.errors.append(f"missing required repository file: {relative_path}")


def _load_workflow(path: Path, root: Path, result: ValidationResult) -> Any | None:
    try:
        workflow = yaml.load(path.read_text(encoding="utf-8"), Loader=UniqueKeyLoader)
    except Exception as exc:  # noqa: BLE001 - report malformed workflow as validation failure
        result.errors.append(f"{relative(path, root)}: invalid workflow YAML: {exc}")
        return None
    if not isinstance(workflow, dict):
        result.errors.append(f"{relative(path, root)}: workflow must be a mapping")
        return None
    return workflow


def _validate_required_trigger(
    trigger_config: Any,
    trigger_name: str,
    path: Path,
    root: Path,
    result: ValidationResult,
) -> Any | None:
    if not isinstance(trigger_config, dict) or trigger_name not in trigger_config:
        result.errors.append(f"{relative(path, root)}: workflow must trigger on {trigger_name}")
        return None
    config = trigger_config[trigger_name]
    if config is not None and not isinstance(config, dict):
        result.errors.append(f"{relative(path, root)}: {trigger_name} trigger must be a mapping or null")
        return None
    if isinstance(config, dict) and any(key in config for key in ("paths", "paths-ignore")):
        result.errors.append(
            f"{relative(path, root)}: {trigger_name} trigger must not filter paths"
        )
    return config


def validate_github_actions_inventory(root: Path, result: ValidationResult) -> None:
    workflows_dir = root / ".github" / "workflows"
    if not workflows_dir.is_dir():
        return
    workflow_files = {
        path.name
        for path in workflows_dir.iterdir()
        if path.is_file() and path.suffix in {".yml", ".yaml"}
    }
    unexpected_workflows = sorted(workflow_files - ALLOWED_WORKFLOW_FILES)
    missing_workflows = sorted(ALLOWED_WORKFLOW_FILES - workflow_files)
    if unexpected_workflows:
        result.errors.append(
            f".github/workflows: unapproved workflow files are forbidden: {unexpected_workflows}"
        )
    if missing_workflows:
        result.errors.append(
            f".github/workflows: missing approved workflow files: {missing_workflows}"
        )

    actions_dir = root / ".github" / "actions"
    if actions_dir.exists():
        result.errors.append(
            ".github/actions: local GitHub Actions are forbidden in the closed validation workflow"
        )


def validate_required_workflow_commands(root: Path, result: ValidationResult) -> None:
    path = root / ".github" / "workflows" / "validate.yml"
    if not path.is_file():
        return
    workflow = _load_workflow(path, root, result)
    if workflow is None:
        return

    triggers = workflow.get("on")
    if isinstance(triggers, dict):
        trigger_names = {str(name) for name in triggers}
        if trigger_names != ALLOWED_WORKFLOW_TRIGGERS:
            result.errors.append(
                f"{relative(path, root)}: workflow triggers must be exactly {sorted(ALLOWED_WORKFLOW_TRIGGERS)}"
            )
    pull_request = _validate_required_trigger(triggers, "pull_request", path, root, result)
    push = _validate_required_trigger(triggers, "push", path, root, result)
    if isinstance(push, dict):
        branches = push.get("branches")
        if not isinstance(branches, list) or REQUIRED_WORKFLOW_PUSH_BRANCH not in branches:
            result.errors.append(
                f"{relative(path, root)}: push trigger must include branch {REQUIRED_WORKFLOW_PUSH_BRANCH!r}"
            )
    elif push is None and isinstance(triggers, dict) and "push" in triggers:
        result.errors.append(
            f"{relative(path, root)}: push trigger must explicitly include branch {REQUIRED_WORKFLOW_PUSH_BRANCH!r}"
        )

    if "defaults" in workflow:
        result.errors.append(f"{relative(path, root)}: validation workflow must not define global defaults")
    if "env" in workflow:
        result.errors.append(f"{relative(path, root)}: validation workflow must not define global env")
    if workflow.get("permissions") != {"contents": "read"}:
        result.errors.append(
            f"{relative(path, root)}: validation workflow permissions must be exactly contents: read"
        )

    jobs = workflow.get("jobs")
    if isinstance(jobs, dict) and set(jobs) != {"validate"}:
        result.errors.append(
            f"{relative(path, root)}: validation workflow jobs must be exactly ['validate']"
        )
    validate_job = jobs.get("validate") if isinstance(jobs, dict) else None
    if not isinstance(validate_job, dict):
        result.errors.append(f"{relative(path, root)}: missing jobs.validate mapping")
        return
    if "if" in validate_job:
        result.errors.append(f"{relative(path, root)}: validate job must not define if")
    if "continue-on-error" in validate_job:
        result.errors.append(f"{relative(path, root)}: validate job must not continue on error")
    if "needs" in validate_job:
        result.errors.append(f"{relative(path, root)}: validate job must not depend on another job")
    allowed_job_keys = {"runs-on", "timeout-minutes", "env", "steps", "if", "continue-on-error", "needs"}
    unexpected_job_keys = sorted(set(validate_job) - allowed_job_keys)
    if unexpected_job_keys:
        result.errors.append(
            f"{relative(path, root)}: validate job contains unsupported keys: {unexpected_job_keys}"
        )
    if validate_job.get("runs-on") != REQUIRED_WORKFLOW_RUNNER:
        result.errors.append(
            f"{relative(path, root)}: validate job must run on {REQUIRED_WORKFLOW_RUNNER}"
        )
    if validate_job.get("timeout-minutes") != REQUIRED_WORKFLOW_TIMEOUT_MINUTES:
        result.errors.append(
            f"{relative(path, root)}: validate job timeout-minutes must be {REQUIRED_WORKFLOW_TIMEOUT_MINUTES}"
        )

    environment = validate_job.get("env")
    expected_environment = {"PYTHONDONTWRITEBYTECODE": "1"}
    normalized_environment = (
        {str(key): str(value) for key, value in environment.items()}
        if isinstance(environment, dict)
        else None
    )
    if normalized_environment != expected_environment:
        result.errors.append(
            f"{relative(path, root)}: validate job must set PYTHONDONTWRITEBYTECODE to 1 and define no other env values"
        )

    steps = validate_job.get("steps")
    if not isinstance(steps, list):
        result.errors.append(f"{relative(path, root)}: validate job steps must be a list")
        return
    if len(steps) != 7:
        result.errors.append(
            f"{relative(path, root)}: validate job must contain exactly seven approved steps"
        )
        return
    if not all(isinstance(step, dict) for step in steps):
        result.errors.append(f"{relative(path, root)}: every validate job step must be a mapping")
        return

    (
        checkout_step,
        python_step,
        install_step,
        validator_step,
        mutation_step,
        archive_build_step,
        archive_validation_step,
    ) = steps
    action_specs = (
        (checkout_step, "actions/checkout@", "checkout", {"name", "uses", "with"}),
        (python_step, "actions/setup-python@", "setup-python", {"name", "uses", "with"}),
    )
    for step, prefix, label, allowed_keys in action_specs:
        unexpected_keys = sorted(set(step) - allowed_keys)
        if unexpected_keys:
            result.errors.append(
                f"{relative(path, root)}: {label} step contains unsupported keys: {unexpected_keys}"
            )
        action_ref = step.get("uses")
        if not isinstance(action_ref, str) or not action_ref.startswith(prefix):
            result.errors.append(
                f"{relative(path, root)}: validate job {label} step must use {prefix}<full-commit-sha>"
            )
    checkout_with = checkout_step.get("with")
    if checkout_with != {"persist-credentials": False}:
        result.errors.append(
            f"{relative(path, root)}: checkout step must set persist-credentials: false and no other options"
        )

    python_with = python_step.get("with")
    if python_with != {"python-version": REQUIRED_WORKFLOW_PYTHON_VERSION}:
        result.errors.append(
            f"{relative(path, root)}: setup-python step must select Python {REQUIRED_WORKFLOW_PYTHON_VERSION}"
        )

    run_specs = (
        (install_step, REQUIRED_WORKFLOW_INSTALL_COMMAND, "dependency installation"),
        (validator_step, REQUIRED_WORKFLOW_COMMANDS[0], "definition validation"),
        (mutation_step, REQUIRED_WORKFLOW_COMMANDS[1], "mutation tests"),
        (archive_build_step, REQUIRED_RELEASE_ARCHIVE_BUILD_COMMAND, "release archive build"),
        (archive_validation_step, REQUIRED_RELEASE_ARCHIVE_VALIDATION_COMMAND, "release archive validation"),
    )
    for step, command, label in run_specs:
        if "if" in step:
            result.errors.append(
                f"{relative(path, root)}: required validation step must not define if: {command}"
            )
        if "continue-on-error" in step:
            result.errors.append(
                f"{relative(path, root)}: required validation step must not continue on error: {command}"
            )
        if "shell" in step:
            result.errors.append(
                f"{relative(path, root)}: required validation step must not override shell: {command}"
            )
        unexpected_keys = sorted(set(step) - {"name", "run", "if", "continue-on-error", "shell"})
        if unexpected_keys:
            result.errors.append(
                f"{relative(path, root)}: {label} step contains unsupported keys: {unexpected_keys}"
            )
        if not isinstance(step.get("run"), str) or step["run"].strip() != command:
            result.errors.append(
                f"{relative(path, root)}: missing required validation command in jobs.validate: {command}"
            )


def validate_conformance_contract(root: Path, result: ValidationResult) -> None:
    path = root / "tests" / "conformance.md"
    if not path.is_file():
        return
    text = path.read_text(encoding="utf-8")
    headings = re.findall(r"(?m)^### (CONF-\d{3})\b", text)
    duplicates = sorted({case_id for case_id in headings if headings.count(case_id) > 1})
    if duplicates:
        result.errors.append(
            f"{relative(path, root)}: duplicate conformance case IDs: {duplicates}"
        )
    missing = sorted(set(REQUIRED_CONFORMANCE_CASE_IDS) - set(headings))
    if missing:
        result.errors.append(
            f"{relative(path, root)}: missing required conformance cases: {missing}"
        )

    case_matches = list(re.finditer(r"(?m)^### (CONF-\d{3})\b.*$", text))
    for index, match in enumerate(case_matches):
        case_id = match.group(1)
        end = case_matches[index + 1].start() if index + 1 < len(case_matches) else len(text)
        section = text[match.end():end]
        input_count = section.count("**Input**")
        expected_count = section.count("**Expected**")
        if input_count != 1:
            result.errors.append(
                f"{relative(path, root)}: {case_id} must contain exactly one **Input** section"
            )
        if expected_count != 1:
            result.errors.append(
                f"{relative(path, root)}: {case_id} must contain exactly one **Expected** section"
            )
        if input_count != 1 or expected_count != 1:
            continue
        input_start = section.index("**Input**") + len("**Input**")
        expected_start = section.index("**Expected**")
        if input_start > expected_start:
            result.errors.append(
                f"{relative(path, root)}: {case_id} must place **Input** before **Expected**"
            )
            continue
        input_text = section[input_start:expected_start].strip()
        expected_text = section[expected_start + len("**Expected**"):].strip()
        if not input_text:
            result.errors.append(f"{relative(path, root)}: {case_id} Input must not be empty")
        if not expected_text:
            result.errors.append(f"{relative(path, root)}: {case_id} Expected must not be empty")
        elif re.search(r"(?m)^-\s+\S", expected_text) is None:
            result.errors.append(
                f"{relative(path, root)}: {case_id} Expected must contain at least one concrete bullet"
            )

    run_record_match = re.search(
        r"(?ms)^## Run record\s+.*?```yaml\s*(.*?)```",
        text,
    )
    if run_record_match is None:
        result.errors.append(f"{relative(path, root)}: missing YAML run-record template")
        return
    try:
        run_record = yaml.load(run_record_match.group(1), Loader=UniqueKeyLoader)
    except Exception as exc:  # noqa: BLE001 - report malformed template
        result.errors.append(f"{relative(path, root)}: invalid run-record YAML: {exc}")
        return
    if not isinstance(run_record, dict):
        result.errors.append(f"{relative(path, root)}: run-record template must be a mapping")
        return
    if "dandori_revision" not in run_record:
        result.errors.append(f"{relative(path, root)}: run-record template is missing dandori_revision")
    cases = run_record.get("cases")
    if not isinstance(cases, dict):
        result.errors.append(f"{relative(path, root)}: run-record cases must be a mapping")
        return
    defined_case_ids = set(headings)
    missing_run_cases = sorted(defined_case_ids - set(cases))
    if missing_run_cases:
        result.errors.append(
            f"{relative(path, root)}: run-record template is missing cases: {missing_run_cases}"
        )
    unknown_run_cases = sorted(set(cases) - defined_case_ids)
    if unknown_run_cases:
        result.errors.append(
            f"{relative(path, root)}: run-record template contains undefined cases: {unknown_run_cases}"
        )
    invalid_placeholders = sorted(
        case_id
        for case_id, value in cases.items()
        if value != "pass|fail|blocked|not_run"
    )
    if invalid_placeholders:
        result.errors.append(
            f"{relative(path, root)}: run-record cases must use the standard placeholder: {invalid_placeholders}"
        )


def validate_required_mutation_tests(root: Path, result: ValidationResult) -> None:
    path = root / "tests" / "test_validate_definitions.py"
    if not path.is_file():
        return
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError as exc:
        result.errors.append(f"{relative(path, root)}: invalid Python syntax: {exc}")
        return
    classes = [
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "ValidatorMutationTests"
    ]
    if len(classes) != 1:
        result.errors.append(
            f"{relative(path, root)}: expected exactly one ValidatorMutationTests class"
        )
        return
    methods = {
        node.name: node
        for node in classes[0].body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    missing = sorted(REQUIRED_MUTATION_TEST_METHODS - set(methods))
    if missing:
        result.errors.append(
            f"{relative(path, root)}: missing required mutation tests: {missing}"
        )

    helper_requirements = {
        "make_repo": {"TemporaryDirectory", "copytree"},
        "assert_valid": {"validate_repository", "assertEqual"},
        "assert_invalid": {"validate_repository", "assertTrue"},
    }
    for helper_name, required_calls in helper_requirements.items():
        helper = methods.get(helper_name)
        if helper is None:
            result.errors.append(
                f"{relative(path, root)}: missing required mutation test helper: {helper_name}"
            )
            continue
        called_names = {
            call.func.attr if isinstance(call.func, ast.Attribute) else call.func.id
            for call in ast.walk(helper)
            if isinstance(call, ast.Call) and isinstance(call.func, (ast.Attribute, ast.Name))
        }
        if not required_calls.issubset(called_names):
            result.errors.append(
                f"{relative(path, root)}: required mutation test helper is incomplete: {helper_name}"
            )

    mutation_calls = {"write_text", "write_bytes", "unlink", "rmtree", "symlink_to", "mkdir", "run"}
    for method_name in sorted(REQUIRED_MUTATION_TEST_METHODS & set(methods)):
        method = methods[method_name]
        called_names = {
            call.func.attr if isinstance(call.func, ast.Attribute) else call.func.id
            for call in ast.walk(method)
            if isinstance(call, ast.Call) and isinstance(call.func, (ast.Attribute, ast.Name))
        }
        if method_name == "test_repository_is_valid":
            complete = "assert_valid" in called_names
        else:
            complete = (
                "make_repo" in called_names
                and "assert_invalid" in called_names
                and bool(mutation_calls.intersection(called_names))
            )
        if not complete:
            result.errors.append(
                f"{relative(path, root)}: required mutation test body is incomplete: {method_name}"
            )


def _iter_key_values(value: Any, key: str, location: str = "") -> list[tuple[str, Any]]:
    found: list[tuple[str, Any]] = []
    if isinstance(value, dict):
        for item_key, item_value in value.items():
            item_location = f"{location}.{item_key}" if location else str(item_key)
            if item_key == key:
                found.append((item_location, item_value))
            found.extend(_iter_key_values(item_value, key, item_location))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            item_location = f"{location}[{index}]"
            found.extend(_iter_key_values(item, key, item_location))
    return found


def validate_workflow_action_pins(root: Path, result: ValidationResult) -> None:
    workflows_dir = root / ".github" / "workflows"
    if not workflows_dir.is_dir():
        result.errors.append("missing .github/workflows directory")
        return

    workflow_files = sorted((*workflows_dir.glob("*.yml"), *workflows_dir.glob("*.yaml")))
    if not workflow_files:
        result.errors.append("no GitHub Actions workflow definitions found")
        return

    for path in workflow_files:
        workflow = _load_workflow(path, root, result)
        if workflow is None:
            continue
        for location, raw_action_ref in _iter_key_values(workflow, "uses"):
            if not isinstance(raw_action_ref, str) or not raw_action_ref.strip():
                result.errors.append(
                    f"{relative(path, root)}:{location}: uses must be a non-empty string"
                )
                continue
            action_ref = raw_action_ref.strip()
            if action_ref.startswith("./"):
                continue
            if action_ref.startswith("docker://"):
                if not DOCKER_IMAGE_DIGEST_PATTERN.fullmatch(action_ref):
                    result.errors.append(
                        f"{relative(path, root)}:{location}: Docker action must be pinned to a sha256 digest: {action_ref}"
                    )
                continue
            if "@" not in action_ref:
                result.errors.append(
                    f"{relative(path, root)}:{location}: external action reference is missing @<full-commit-sha>"
                )
                continue
            _, revision = action_ref.rsplit("@", 1)
            if not FULL_COMMIT_SHA_PATTERN.fullmatch(revision):
                result.errors.append(
                    f"{relative(path, root)}:{location}: external action must be pinned to a full-length commit SHA: {action_ref}"
                )


def validate_repository(root: Path) -> ValidationResult:
    root = root.resolve()
    result = ValidationResult()
    agents_dir = root / ".copilot" / "agents"
    skills_dir = root / ".copilot" / "skills"
    validate_repository_symlinks(root, result)
    validate_required_repository_files(root, result)

    validate_gitignore_policy(root, result)
    validate_tracked_generated_artifacts(root, result)
    validate_github_actions_inventory(root, result)

    readmes = (
        (root / "README.md", ("## What's included", "## Installation", "## Design principles")),
        (root / "README_ja.md", ("## 含まれるもの", "## インストール", "## 設計原則")),
    )

    if not agents_dir.is_dir():
        result.errors.append("missing .copilot/agents directory")
        return result
    if not skills_dir.is_dir():
        result.errors.append("missing .copilot/skills directory")

    unexpected_agent_entries = sorted(
        path for path in agents_dir.iterdir() if not (path.is_file() and path.name.endswith(".agent.md"))
    )
    for unexpected in unexpected_agent_entries:
        result.errors.append(
            f"{relative(unexpected, root)}: unexpected agent-directory entry; only *.agent.md files are allowed"
        )

    agent_files = sorted(agents_dir.glob("*.agent.md"))
    if not agent_files:
        result.errors.append("no agent definitions found")
        return result

    lower_filenames: dict[str, Path] = {}
    definitions: dict[str, Definition] = {}
    lower_names: dict[str, str] = {}

    for path in agent_files:
        lower_filename = path.name.casefold()
        if lower_filename in lower_filenames:
            result.errors.append(
                f"case-insensitive duplicate agent filename: {lower_filenames[lower_filename].name}, {path.name}"
            )
        lower_filenames[lower_filename] = path

        try:
            meta, body = frontmatter(path)
        except Exception as exc:  # noqa: BLE001 - collect all definition failures
            result.errors.append(f"{relative(path, root)}: invalid frontmatter: {exc}")
            continue

        forbidden_keys = sorted(set(meta) & FORBIDDEN_AGENT_FRONTMATTER_KEYS)
        if forbidden_keys:
            result.errors.append(
                f"{relative(path, root)}: forbidden agent frontmatter keys: {forbidden_keys}"
            )

        name = meta.get("name")
        if not isinstance(name, str) or not name.strip():
            result.errors.append(f"{relative(path, root)}: missing non-empty name")
            continue
        name = name.strip()
        if name in BUNDLED_AGENT_NAMES:
            missing_keys = sorted(BUNDLED_AGENT_FRONTMATTER_KEYS - set(meta))
            unexpected_keys = sorted(
                set(meta) - BUNDLED_AGENT_FRONTMATTER_KEYS - FORBIDDEN_AGENT_FRONTMATTER_KEYS
            )
            if missing_keys:
                result.errors.append(
                    f"{relative(path, root)}: bundled agent frontmatter is missing required keys: {missing_keys}"
                )
            if unexpected_keys:
                result.errors.append(
                    f"{relative(path, root)}: bundled agent frontmatter contains unsupported keys: {unexpected_keys}"
                )
            expected_filename = f"{name}.agent.md"
            if path.name != expected_filename:
                result.errors.append(
                    f"{relative(path, root)}: bundled agent filename must be {expected_filename!r}"
                )
        if name in definitions:
            result.errors.append(f"duplicate agent name {name!r}: {definitions[name].path.name}, {path.name}")
        folded = name.casefold()
        if folded in lower_names and lower_names[folded] != name:
            result.errors.append(f"case-insensitive duplicate agent name: {lower_names[folded]!r}, {name!r}")
        lower_names[folded] = name

        description = meta.get("description")
        if not isinstance(description, str) or not description.strip():
            result.errors.append(f"{relative(path, root)}: missing non-empty description")

        if len(body) > MAX_AGENT_BODY_CHARS:
            result.errors.append(
                f"{relative(path, root)}: agent body exceeds {MAX_AGENT_BODY_CHARS} characters ({len(body)})"
            )
        minimum_body_chars = BUNDLED_AGENT_MIN_BODY_CHARS.get(name)
        if minimum_body_chars is not None and len(body) < minimum_body_chars:
            result.errors.append(
                f"{relative(path, root)}: bundled agent body is below the regression floor of "
                f"{minimum_body_chars} characters ({len(body)})"
            )

        try:
            tools = normalize_tools(meta.get("tools"))
        except DefinitionError as exc:
            result.errors.append(f"{relative(path, root)}: {exc}")
            tools = []
        if len(tools) != len(set(tools)):
            result.errors.append(f"{relative(path, root)}: tools contain duplicates")

        validate_relative_links(path, body, root, result)
        definitions[name] = Definition(path=path, meta=meta, body=body)

    orchestrator = definitions.get("Orchestrator")
    if orchestrator is None:
        result.errors.append("Orchestrator agent is missing")
        return result

    try:
        orchestrator_tools = normalize_tools(orchestrator.meta.get("tools"))
    except DefinitionError:
        orchestrator_tools = []

    for definition in definitions.values():
        if definition.meta.get("target") != "vscode":
            result.errors.append(f"{relative(definition.path, root)}: agent must set target: vscode")
    if orchestrator.meta.get("user-invocable") is not True:
        result.errors.append(f"{relative(orchestrator.path, root)}: Orchestrator must set user-invocable: true")
    if orchestrator.meta.get("disable-model-invocation") is not True:
        result.errors.append(
            f"{relative(orchestrator.path, root)}: Orchestrator must set disable-model-invocation: true"
        )
    if orchestrator_tools != ["agent"]:
        result.errors.append(
            f"{relative(orchestrator.path, root)}: Orchestrator tools must be exactly ['agent']"
        )

    for marker in ORCHESTRATOR_REQUIRED_MARKERS:
        if marker not in orchestrator.body:
            result.errors.append(f"{relative(orchestrator.path, root)}: missing required Orchestrator marker {marker!r}")
    for invariant in ORCHESTRATOR_REQUIRED_INVARIANTS:
        if invariant not in orchestrator.body:
            result.errors.append(
                f"{relative(orchestrator.path, root)}: missing required Orchestrator invariant {invariant!r}"
            )
    validate_section_markers(
        orchestrator.path,
        orchestrator.body,
        ORCHESTRATOR_REQUIRED_SECTION_MARKERS,
        root,
        result,
        "Orchestrator",
    )
    for marker in ORCHESTRATOR_FORBIDDEN_MARKERS:
        if marker in orchestrator.body:
            result.errors.append(f"{relative(orchestrator.path, root)}: forbidden legacy marker {marker!r}")

    allowed_agents = orchestrator.meta.get("agents")
    if not isinstance(allowed_agents, list) or not allowed_agents:
        result.errors.append(f"{relative(orchestrator.path, root)}: agents allowlist must be a non-empty list")
        allowed_agents = []
    elif not all(isinstance(name, str) and name.strip() for name in allowed_agents):
        result.errors.append(f"{relative(orchestrator.path, root)}: agents allowlist must contain non-empty strings")
        allowed_agents = []
    else:
        allowed_agents = [name.strip() for name in allowed_agents]
        if len(allowed_agents) != len(set(allowed_agents)):
            result.errors.append(f"{relative(orchestrator.path, root)}: agents allowlist contains duplicates")
        if "Orchestrator" in allowed_agents:
            result.errors.append(f"{relative(orchestrator.path, root)}: Orchestrator must not allowlist itself")

    local_workers = set(definitions) - {"Orchestrator"}
    missing_bundled_definitions = sorted(set(BUNDLED_WORKER_TOOLS) - local_workers)
    if missing_bundled_definitions:
        result.errors.append(f"bundled worker definitions are missing: {missing_bundled_definitions}")
    missing_bundled = sorted(set(BUNDLED_WORKER_TOOLS) - set(allowed_agents))
    if missing_bundled:
        result.errors.append(
            f"{relative(orchestrator.path, root)}: bundled workers missing from allowlist: {missing_bundled}"
        )
    for custom_name in sorted(local_workers - set(BUNDLED_WORKER_TOOLS)):
        result.warnings.append(
            f"{relative(definitions[custom_name].path, root)}: custom local worker requires policy and Diagnostics review: {custom_name}"
        )
    for external_name in sorted(set(allowed_agents) - local_workers):
        result.warnings.append(
            f"{relative(orchestrator.path, root)}: external allowlisted agent requires Diagnostics review: {external_name}"
        )

    for name, definition in definitions.items():
        if name == "Orchestrator":
            continue
        meta = definition.meta
        if meta.get("user-invocable") is not False:
            result.errors.append(f"{relative(definition.path, root)}: worker must set user-invocable: false")
        if meta.get("disable-model-invocation") is not True:
            result.errors.append(f"{relative(definition.path, root)}: worker must set disable-model-invocation: true")
        if meta.get("agents") != []:
            result.errors.append(f"{relative(definition.path, root)}: worker must set agents: []")
        try:
            worker_tools = normalize_tools(meta.get("tools"))
        except DefinitionError:
            worker_tools = []
        if "agent" in worker_tools:
            result.errors.append(f"{relative(definition.path, root)}: worker must not include the agent tool")
        expected_tools = BUNDLED_WORKER_TOOLS.get(name)
        if expected_tools is not None and set(worker_tools) != expected_tools:
            result.errors.append(
                f"{relative(definition.path, root)}: bundled worker tools changed; "
                f"expected={sorted(expected_tools)}, actual={sorted(worker_tools)}"
            )
        if name in BUNDLED_WORKER_TOOLS:
            for marker in BUNDLED_WORKER_REQUIRED_MARKERS[name]:
                if marker not in definition.body:
                    result.errors.append(
                        f"{relative(definition.path, root)}: missing required bundled-worker policy {marker!r}"
                    )
            validate_section_markers(
                definition.path,
                definition.body,
                BUNDLED_WORKER_REQUIRED_SECTION_MARKERS[name],
                root,
                result,
                "bundled-worker",
            )
        elif definition.path.stem.removesuffix(".agent") != name:
            result.warnings.append(
                f"{relative(definition.path, root)}: filename and display name differ ({definition.path.name!r} vs {name!r})"
            )

        full_definition = definition.path.read_text(encoding="utf-8")
        for label, pattern in DANDORI_COUPLING_PATTERNS.items():
            if pattern.search(full_definition):
                result.errors.append(
                    f"{relative(definition.path, root)}: forbidden DANDORI coupling detected: {label}"
                )

    skill_entries: dict[str, Path] = {}
    if skills_dir.is_dir():
        skill_dirs = sorted(path for path in skills_dir.iterdir() if path.is_dir())
        for skill_dir in skill_dirs:
            skill_file = skill_dir / "SKILL.md"
            if not skill_file.exists():
                result.errors.append(f"{relative(skill_dir, root)}: missing SKILL.md")
                continue
            try:
                meta, body = frontmatter(skill_file)
            except Exception as exc:  # noqa: BLE001
                result.errors.append(f"{relative(skill_file, root)}: invalid frontmatter: {exc}")
                continue
            name = meta.get("name")
            dirname = skill_dir.name
            if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
                result.errors.append(
                    f"{relative(skill_file, root)}: skill name must use lowercase letters, digits, and hyphens"
                )
            elif len(name) > MAX_SKILL_NAME_CHARS:
                result.errors.append(
                    f"{relative(skill_file, root)}: skill name exceeds {MAX_SKILL_NAME_CHARS} characters"
                )
            elif name != dirname:
                result.errors.append(
                    f"{relative(skill_file, root)}: skill name {name!r} must match parent directory {dirname!r}"
                )
            elif name in skill_entries:
                result.errors.append(f"duplicate skill name {name!r}")
            else:
                skill_entries[name] = skill_file

            if name == "code-review":
                unexpected_keys = sorted(set(meta) - CODE_REVIEW_SKILL_FRONTMATTER_KEYS)
                if unexpected_keys:
                    result.errors.append(
                        f"{relative(skill_file, root)}: code-review frontmatter contains unsupported keys: {unexpected_keys}"
                    )
                actual_files = {
                    path.relative_to(skill_dir).as_posix()
                    for path in skill_dir.rglob("*")
                    if path.is_file()
                }
                missing_files = sorted(CODE_REVIEW_SKILL_FILES - actual_files)
                unexpected_files = sorted(actual_files - CODE_REVIEW_SKILL_FILES)
                if missing_files:
                    result.errors.append(
                        f"{relative(skill_dir, root)}: code-review inventory is missing files: {missing_files}"
                    )
                if unexpected_files:
                    result.errors.append(
                        f"{relative(skill_dir, root)}: code-review inventory contains unexpected files: {unexpected_files}"
                    )

            description = meta.get("description")
            if not isinstance(description, str) or not description.strip():
                result.errors.append(f"{relative(skill_file, root)}: missing non-empty skill description")
            elif len(description) > MAX_SKILL_DESCRIPTION_CHARS:
                result.errors.append(
                    f"{relative(skill_file, root)}: skill description exceeds {MAX_SKILL_DESCRIPTION_CHARS} characters"
                )
            if meta.get("user-invocable") is not False:
                result.errors.append(f"{relative(skill_file, root)}: skill must set user-invocable: false")
            if meta.get("disable-model-invocation") is True:
                result.errors.append(
                    f"{relative(skill_file, root)}: skill must remain model-invocable when user-invocable is false"
                )

            for markdown_file in sorted(skill_dir.rglob("*.md")):
                markdown = markdown_file.read_text(encoding="utf-8")
                link_body = body if markdown_file == skill_file else markdown
                validate_relative_links(markdown_file, link_body, root, result)
                for label, pattern in DANDORI_COUPLING_PATTERNS.items():
                    if pattern.search(markdown):
                        result.errors.append(
                            f"{relative(markdown_file, root)}: forbidden DANDORI coupling detected: {label}"
                        )
                for label, pattern in SKILL_WORKER_POLICY_PATTERNS.items():
                    if pattern.search(markdown):
                        result.errors.append(
                            f"{relative(markdown_file, root)}: worker-specific policy must stay in Reviewer.agent.md: {label}"
                        )

    reviewer = definitions.get("Reviewer")
    reviewer_link = "[code-review guidance](../skills/code-review/SKILL.md)"
    if reviewer is not None and reviewer_link not in reviewer.body:
        result.errors.append(
            f"{relative(reviewer.path, root)}: Reviewer must contain exact skill link {reviewer_link!r}"
        )
    if "code-review" not in skill_entries:
        result.errors.append("code-review skill is missing")

    validate_workflow_action_pins(root, result)
    validate_required_workflow_commands(root, result)
    validate_conformance_contract(root, result)
    validate_required_mutation_tests(root, result)

    for readme_path, required_sections in readmes:
        if not readme_path.exists():
            result.errors.append(f"missing {readme_path.name}")
            continue
        text = readme_path.read_text(encoding="utf-8")
        for section in required_sections:
            if section not in text:
                result.errors.append(f"{readme_path.name}: missing required section {section!r}")
        for agent_path in agent_files:
            if agent_path.name not in text:
                result.errors.append(f"{readme_path.name}: missing agent listing {agent_path.name}")
        for skill_name in skill_entries:
            if skill_name not in text:
                result.errors.append(f"{readme_path.name}: missing skill listing {skill_name}")
        for token in ("observe", "change_local", "execute", "affect_external", "destructive"):
            if token not in text:
                result.errors.append(f"{readme_path.name}: missing effect tag {token}")
        for location in (".copilot/", "~/.copilot/agents", "~/.copilot/skills"):
            if location not in text:
                result.errors.append(f"{readme_path.name}: missing installation/distribution path {location}")

    return result


def print_result(result: ValidationResult) -> int:
    for warning in result.warnings:
        print(f"DANDORI validation warning: {warning}", file=sys.stderr)
    if result.errors:
        print("DANDORI definition validation failed:", file=sys.stderr)
        for error in result.errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("DANDORI definition validation passed.")
    return 0


def main() -> int:
    return print_result(validate_repository(DEFAULT_ROOT))


if __name__ == "__main__":
    raise SystemExit(main())
