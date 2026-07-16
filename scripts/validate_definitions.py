#!/usr/bin/env python3
"""Validate DANDORI custom-agent and skill definitions deterministically."""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover - local setup guidance
    raise SystemExit("PyYAML is required: python -m pip install PyYAML==6.0.3") from exc

ROOT = Path(__file__).resolve().parents[1]
AGENTS_DIR = ROOT / ".copilot" / "agents"
SKILLS_DIR = ROOT / ".copilot" / "skills"
README_EN = ROOT / "README.md"
README_JA = ROOT / "README_ja.md"


class UniqueKeyLoader(yaml.SafeLoader):
    """Safe YAML loader that rejects duplicate mapping keys."""


def _construct_unique_mapping(loader: UniqueKeyLoader, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
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


def frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("missing opening frontmatter delimiter")
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration as exc:
        raise ValueError("missing closing frontmatter delimiter") from exc
    raw = "\n".join(lines[1:end])
    data = yaml.load(raw, Loader=UniqueKeyLoader)
    if not isinstance(data, dict):
        raise ValueError("frontmatter must be a mapping")
    return data, "\n".join(lines[end + 1 :])


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def validate_relative_links(path: Path, body: str, errors: list[str]) -> None:
    for target in re.findall(r"!?(?:\[[^\]]*\])\(([^)]+)\)", body):
        target = target.strip().split("#", 1)[0]
        if not target or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
            continue
        candidate = (path.parent / target).resolve()
        try:
            candidate.relative_to(ROOT.resolve())
        except ValueError:
            errors.append(f"{path.relative_to(ROOT)}: relative link escapes repository: {target}")
            continue
        if not candidate.exists():
            errors.append(f"{path.relative_to(ROOT)}: missing relative link target: {target}")


def main() -> int:
    errors: list[str] = []

    agent_files = sorted(AGENTS_DIR.glob("*.agent.md"))
    if not agent_files:
        errors.append("no agent definitions found")
        return finish(errors)

    agents: dict[str, tuple[Path, dict[str, Any], str]] = {}
    for path in agent_files:
        try:
            meta, body = frontmatter(path)
        except Exception as exc:  # noqa: BLE001 - aggregate all validation errors
            errors.append(f"{path.relative_to(ROOT)}: invalid frontmatter: {exc}")
            continue
        name = meta.get("name")
        if not isinstance(name, str) or not name.strip():
            errors.append(f"{path.relative_to(ROOT)}: missing non-empty name")
            continue
        if name in agents:
            errors.append(f"duplicate agent name {name!r}: {agents[name][0].name}, {path.name}")
        agents[name] = (path, meta, body)

    orchestrator = agents.get("Orchestrator")
    if not orchestrator:
        errors.append("Orchestrator agent is missing")
    else:
        path, meta, _ = orchestrator
        tools = [str(v) for v in as_list(meta.get("tools"))]
        if "agent" not in tools:
            errors.append(f"{path.relative_to(ROOT)}: Orchestrator must include the agent tool")
        allowed = meta.get("agents")
        if not isinstance(allowed, list) or not allowed:
            errors.append(f"{path.relative_to(ROOT)}: Orchestrator agents allowlist must be a non-empty list")
        else:
            if len(allowed) != len(set(allowed)):
                errors.append(f"{path.relative_to(ROOT)}: Orchestrator agents allowlist contains duplicates")
            for name in allowed:
                if name not in agents:
                    errors.append(f"{path.relative_to(ROOT)}: allowlisted agent does not exist: {name}")
                elif name == "Orchestrator":
                    errors.append(f"{path.relative_to(ROOT)}: Orchestrator must not allowlist itself")
            expected_workers = set(agents) - {"Orchestrator"}
            if set(allowed) != expected_workers:
                missing = sorted(expected_workers - set(allowed))
                extra = sorted(set(allowed) - expected_workers)
                errors.append(
                    f"{path.relative_to(ROOT)}: allowlist must match worker definitions; "
                    f"missing={missing}, extra={extra}"
                )

    forbidden_patterns = {
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

    for name, (path, meta, body) in agents.items():
        if name == "Orchestrator":
            continue
        if meta.get("user-invocable") is not False:
            errors.append(f"{path.relative_to(ROOT)}: worker must set user-invocable: false")
        if meta.get("disable-model-invocation") is not True:
            errors.append(f"{path.relative_to(ROOT)}: worker must set disable-model-invocation: true")
        if meta.get("agents") != []:
            errors.append(f"{path.relative_to(ROOT)}: worker must set agents: []")
        full_definition = path.read_text(encoding="utf-8")
        for label, pattern in forbidden_patterns.items():
            if pattern.search(full_definition):
                errors.append(f"{path.relative_to(ROOT)}: forbidden DANDORI coupling detected: {label}")

    skill_entries: dict[str, Path] = {}
    for skill_dir in sorted(path for path in SKILLS_DIR.iterdir() if path.is_dir()):
        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            errors.append(f"{skill_dir.relative_to(ROOT)}: missing SKILL.md")
            continue
        try:
            meta, body = frontmatter(skill_file)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{skill_file.relative_to(ROOT)}: invalid frontmatter: {exc}")
            continue
        name = meta.get("name")
        dirname = skill_file.parent.name
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
            errors.append(f"{skill_file.relative_to(ROOT)}: skill name must use lowercase letters, digits, and hyphens")
        elif name != dirname:
            errors.append(f"{skill_file.relative_to(ROOT)}: skill name {name!r} must match parent directory {dirname!r}")
        elif name in skill_entries:
            errors.append(f"duplicate skill name {name!r}")
        else:
            skill_entries[name] = skill_file
        validate_relative_links(skill_file, body, errors)
        full_definition = skill_file.read_text(encoding="utf-8")
        for label, pattern in forbidden_patterns.items():
            if pattern.search(full_definition):
                errors.append(f"{skill_file.relative_to(ROOT)}: forbidden DANDORI coupling detected: {label}")

    reviewer = agents.get("Reviewer")
    if reviewer and "code-review" not in reviewer[2]:
        errors.append(f"{reviewer[0].relative_to(ROOT)}: Reviewer must reference the code-review skill")
    if "code-review" not in skill_entries:
        errors.append("code-review skill is missing")

    for readme_path, required_sections in (
        (README_EN, ("## What's included", "## Installation", "## Design principles")),
        (README_JA, ("## 含まれるもの", "## インストール", "## 設計原則")),
    ):
        if not readme_path.exists():
            errors.append(f"missing {readme_path.name}")
            continue
        text = readme_path.read_text(encoding="utf-8")
        for section in required_sections:
            if section not in text:
                errors.append(f"{readme_path.name}: missing required section {section!r}")
        for agent_path in agent_files:
            if agent_path.name not in text:
                errors.append(f"{readme_path.name}: missing agent listing {agent_path.name}")
        for skill_name in skill_entries:
            if skill_name not in text:
                errors.append(f"{readme_path.name}: missing skill listing {skill_name}")
        for token in ("observe", "change_local", "execute", "affect_external", "destructive"):
            if token not in text:
                errors.append(f"{readme_path.name}: missing effect tag {token}")
        for location in (".copilot/", "~/.copilot/agents", "~/.copilot/skills"):
            if location not in text:
                errors.append(f"{readme_path.name}: missing installation/distribution path {location}")

    return finish(errors)


def finish(errors: list[str]) -> int:
    if errors:
        print("DANDORI definition validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("DANDORI definition validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
