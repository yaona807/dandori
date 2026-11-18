#!/usr/bin/env python3
"""Validate DANDORI's two-worker boundaries and generated Copilot artifacts."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import re
import yaml

ROOT = Path(__file__).resolve().parents[1]
NAMES = ("Orchestrator", "Executor", "Reviewer")
FORBIDDEN_TRACKED_FILENAMES = frozenset({".DS_Store", "Thumbs.db"})
FORBIDDEN_TRACKED_PATH_PARTS = frozenset({"__pycache__", ".pytest_cache", ".git", "node_modules"})
FORBIDDEN_TRACKED_SUFFIXES = frozenset({".pyc", ".pyo", ".swp"})
REQUIRED_REPOSITORY_FILES = frozenset({
    ".gitignore", "LICENSE", "README.md", "README_ja.md",
    ".github/workflows/validate.yml",
    "scripts/validate_definitions.py", "scripts/build_agent_profiles.py",
    "scripts/run_tests.py", "scripts/validate_release_archive.py",
    "tests/conformance.md", "tests/test_validate_definitions.py",
    "tests/test_validate_release_archive.py",
    ".copilot/skills/command-runner/SKILL.md",
    ".copilot/skills/command-runner/scripts/cli.mjs",
    ".copilot/skills/command-runner/scripts/hook.mjs",
    ".copilot/skills/command-runner/scripts/orchestrator-guard.mjs",
    ".copilot/skills/command-runner/scripts/gateway.mjs",
    ".copilot/skills/command-runner/scripts/runner.mjs",
    ".copilot/skills/command-runner/tests/gateway.test.mjs",
    ".copilot/skills/command-runner/tests/runner.test.mjs",
    *(".copilot/agents/" + name + ".agent.md" for name in NAMES),
    *("packages/copilot/agents/" + name + ".agent.md" for name in NAMES),
})
READ_GITHUB = frozenset("github/" + name for name in (
    "get_me", "search_repositories", "pull_request_read", "list_pull_requests",
    "search_pull_requests", "issue_read", "list_issues", "search_issues",
    "actions_get", "actions_list", "get_job_logs", "get_file_contents",
    "get_commit", "list_branches", "list_commits", "search_code", "search_commits",
))

class ValidationResult:
    def __init__(self) -> None:
        self.errors: list[str] = []
    @property
    def ok(self) -> bool:
        return not self.errors

def require(ok: bool, message: str, errors: list[str]) -> None:
    if not ok:
        errors.append(message)

def read_agent(path: Path, errors: list[str]) -> tuple[dict, str]:
    try:
        content = path.read_text(encoding="utf-8")
        if not content.startswith("---\n"):
            raise ValueError("missing YAML frontmatter")
        _, front, body = content.split("---\n", 2)
        meta = yaml.safe_load(front)
        if not isinstance(meta, dict):
            raise ValueError("frontmatter must be an object")
        return meta, body
    except (OSError, ValueError, yaml.YAMLError) as error:
        errors.append(f"invalid agent {path.name}: {error}")
        return {}, ""

def validate_repository(root: Path) -> ValidationResult:
    result = ValidationResult()
    errors = result.errors
    for file in REQUIRED_REPOSITORY_FILES:
        require((root / file).is_file(), "missing required repository file: " + file, errors)

    expected = {name + ".agent.md" for name in NAMES}
    for directory in (".copilot/agents", "packages/copilot/agents"):
        folder = root / directory
        if folder.is_dir():
            actual = {file.name for file in folder.glob("*.agent.md")}
            require(actual == expected, f"{directory}: agent inventory must be Orchestrator, Executor, Reviewer", errors)

    for name in NAMES:
        path = root / ".copilot/agents" / (name + ".agent.md")
        if not path.is_file():
            continue
        meta, body = read_agent(path, errors)
        require(meta.get("name") == name and meta.get("target") == "vscode",
                f"{name}: invalid source identity", errors)
        require(meta.get("user-invocable") is (name == "Orchestrator"),
                f"{name}: invalid invocability", errors)
        require(meta.get("disable-model-invocation") is True,
                f"{name}: source must disable model invocation", errors)
        hooks = meta.get("hooks")
        require(isinstance(hooks, dict) and "PreToolUse" in hooks,
                f"{name}: scoped Hook is required", errors)
        tools = meta.get("tools")
        require(isinstance(tools, list) and len(tools) == len(set(tools)),
                f"{name}: tools must be a unique list", errors)
        if not isinstance(tools, list):
            continue
        if name == "Orchestrator":
            require(meta.get("agents") == ["Executor", "Reviewer"],
                    "Orchestrator: only Executor and Reviewer may be delegated", errors)
            require(set(tools) == {"agent", "store_memory", "vote_memory", "read_memories"},
                    "Orchestrator: only delegation and memory tools permitted", errors)
            for marker in (
                "Missing permission is denied.", "Task Flow Review",
                "Task Flow Change", "APPROVE:TFR-", "APPROVE:TFC-",
                "normalized patches", "Contract revision", "## Worker selection",
                "reviewer", "parallel", "Host approval",
            ):
                require(marker.lower() in body.lower(),
                        "Orchestrator: missing policy " + marker, errors)
        elif name == "Executor":
            for expected_tool in ("read", "search", "web", "edit", "execute",
                                  "execute/runInTerminal", "browser/readPage",
                                  "github/create_pull_request"):
                require(expected_tool in tools, "Executor: missing tool " + expected_tool, errors)
            require("Do not execute raw project commands" in body,
                    "Executor: fixed runner policy missing", errors)
        else:
            require("execute/runInTerminal" in tools and "execute" in tools,
                    "Reviewer: fixed CommandRunner execution required", errors)
            require(not any(
                tool in ("edit", "agent", "task") or tool.startswith(("edit/", "browser/"))
                or (tool.startswith("github/") and tool not in READ_GITHUB)
                for tool in tools
            ), "Reviewer: write, browser and delegation tools forbidden", errors)
            for marker in ("Do not edit source files",
                           "Do not execute raw project commands",
                           "Do not create GitHub comments"):
                require(marker in body, "Reviewer: read-only execution policy missing " + marker, errors)
        if name != "Orchestrator":
            require("hook.mjs" in str(hooks), f"{name}: fixed runner Hook missing", errors)
            require("node ~/.copilot/skills/command-runner/scripts/cli.mjs" in body,
                    f"{name}: fixed runner CLI missing", errors)
            require(not re.search(r"\b(?:Task Card|Flow Ledger|Orchestrator)\b", body),
                    f"{name}: worker should not embed orchestration internals", errors)

    builder_path = root / "scripts/build_agent_profiles.py"
    if builder_path.is_file():
        try:
            spec = importlib.util.spec_from_file_location("dandori_validator_builder", builder_path)
            if spec is None or spec.loader is None:
                raise ValueError("unable to load builder")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            for name in NAMES:
                source = root / ".copilot/agents" / (name + ".agent.md")
                bundle = root / "packages/copilot/agents" / (name + ".agent.md")
                if source.is_file() and bundle.is_file():
                    expected_bundle = module.transform(source.read_text(encoding="utf-8"), name)
                    require(bundle.read_text(encoding="utf-8") == expected_bundle,
                            "outdated bundle file: copilot/agents/" + name + ".agent.md", errors)
        except (OSError, ValueError, yaml.YAMLError, ImportError) as exc:
            errors.append("invalid generated profile: " + str(exc))
    skill_root, skill_bundle = root / ".copilot/skills", root / "packages/copilot/skills"
    if skill_root.is_dir():
        expected_skills = {p.relative_to(skill_root): p.read_bytes()
                           for p in skill_root.rglob("*") if p.is_file()}
        actual_skills = ({p.relative_to(skill_bundle): p.read_bytes()
                          for p in skill_bundle.rglob("*") if p.is_file()}
                         if skill_bundle.is_dir() else {})
        require(expected_skills == actual_skills, "outdated bundle files: copilot/skills", errors)

    workflow = root / ".github/workflows/validate.yml"
    if workflow.is_file():
        text = workflow.read_text(encoding="utf-8")
        for line in ("python scripts/validate_definitions.py", "python scripts/run_tests.py",
                     "python scripts/validate_release_archive.py", "git archive"):
            require(line in text, "CI workflow missing " + line, errors)

    for path in root.rglob("*"):
        rel = path.relative_to(root)
        if FORBIDDEN_TRACKED_PATH_PARTS.intersection(rel.parts):
            continue  # generated files are excluded by release ZIP validation
        if path.is_symlink():
            errors.append("repository symlinks are forbidden: " + rel.as_posix())
    return result

def main() -> int:
    validation = validate_repository(ROOT)
    for error in validation.errors:
        print(error)
    if validation.ok:
        print("DANDORI definitions validated")
    return 0 if validation.ok else 1

if __name__ == "__main__":
    raise SystemExit(main())
