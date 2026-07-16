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
        "read/problems",
        "edit/editFiles",
        "edit/createFile",
        "edit/createDirectory",
    },
}

ORCHESTRATOR_REQUIRED_MARKERS = (
    "**Authorized operations**",
    "normalized_patch:",
    "completion_criteria:",
    "verification_requirements:",
    "criterion_refs:",
    "expected_delta:",
    "**Contract patch**",
    "set_auto_added_targets_max:",
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
DANDORI_COUPLING_PATTERNS = {
    "Task Card": re.compile(r"\bTask Card\b"),
    "TFR": re.compile(r"\bTFR\b"),
    "TFC": re.compile(r"\bTFC\b"),
    "Flow Ledger": re.compile(r"\bFlow Ledger\b"),
    "Approved Contract": re.compile(r"\bApproved Contract\b"),
    "access.* protocol": re.compile(r"\baccess\.[A-Za-z_]"),
    "scope.* protocol": re.compile(r"\bscope\.[A-Za-z_]"),
    "target_boundary.* protocol": re.compile(r"\btarget_boundary\.[A-Za-z_]"),
    "browser_interaction_policy.* protocol": re.compile(r"\bbrowser_interaction_policy\.[A-Za-z_]"),
    "worker_response envelope": re.compile(r"\bworker_response\b"),
    "suggested_next_capability routing": re.compile(r"\bsuggested_next_capability\b"),
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

        name = meta.get("name")
        if not isinstance(name, str) or not name.strip():
            result.errors.append(f"{relative(path, root)}: missing non-empty name")
            continue
        name = name.strip()
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
    missing_bundled = sorted(set(BUNDLED_WORKER_TOOLS) - set(allowed_agents))
    if missing_bundled:
        result.errors.append(
            f"{relative(orchestrator.path, root)}: bundled workers missing from allowlist: {missing_bundled}"
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
            expected_filename = f"{name}.agent.md"
            if definition.path.name != expected_filename:
                result.errors.append(
                    f"{relative(definition.path, root)}: bundled worker filename must be {expected_filename!r}"
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
            full_skill = skill_file.read_text(encoding="utf-8")
            for label, pattern in SKILL_WORKER_POLICY_PATTERNS.items():
                if pattern.search(full_skill):
                    result.errors.append(
                        f"{relative(skill_file, root)}: worker-specific policy must stay in Reviewer.agent.md: {label}"
                    )

    reviewer = definitions.get("Reviewer")
    reviewer_link = "[code-review guidance](../skills/code-review/SKILL.md)"
    if reviewer is not None and reviewer_link not in reviewer.body:
        result.errors.append(
            f"{relative(reviewer.path, root)}: Reviewer must contain exact skill link {reviewer_link!r}"
        )
    if "code-review" not in skill_entries:
        result.errors.append("code-review skill is missing")

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
