#!/usr/bin/env python3
"""Validate DANDORI agent, skill, documentation, and policy definitions."""

from __future__ import annotations

import re
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
    """Safe YAML loader that rejects duplicate mapping keys."""


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
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            content = line.split("#", 1)[0].strip()
            match = re.fullmatch(r"(?:-\s*)?uses:\s*(.+)", content)
            if match is None:
                continue
            action_ref = match.group(1).strip().strip("\"'")
            if action_ref.startswith("./") or action_ref.startswith("docker://"):
                continue
            if "@" not in action_ref:
                result.errors.append(
                    f"{relative(path, root)}:{line_number}: external action reference is missing @<full-commit-sha>"
                )
                continue
            _, revision = action_ref.rsplit("@", 1)
            if not FULL_COMMIT_SHA_PATTERN.fullmatch(revision):
                result.errors.append(
                    f"{relative(path, root)}:{line_number}: external action must be pinned to a full-length commit SHA: {action_ref}"
                )


def validate_repository(root: Path) -> ValidationResult:
    root = root.resolve()
    result = ValidationResult()
    agents_dir = root / ".copilot" / "agents"
    skills_dir = root / ".copilot" / "skills"
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
