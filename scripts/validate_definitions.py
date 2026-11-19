#!/usr/bin/env python3
"""Validate DANDORI's two-worker boundaries and generated Copilot artifacts."""
from __future__ import annotations

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
    ".copilot/skills/task-reflection/SKILL.md",
    "packages/copilot/skills/task-reflection/SKILL.md",
    ".copilot/skills/test-design/SKILL.md",
    "packages/copilot/skills/test-design/SKILL.md",
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


def validate_ci_workflow(path: Path, errors: list[str]) -> None:
    """Keep CI read-only, SHA-pinned and unable to silently skip the checks."""
    try:
        workflow = yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
    except (OSError, yaml.YAMLError) as exc:
        errors.append(f"invalid CI workflow: {exc}")
        return
    if not isinstance(workflow, dict):
        errors.append("invalid CI workflow structure")
        return
    triggers = workflow.get("on")
    if (not isinstance(triggers, dict)
            or set(triggers) != {"pull_request", "push"}
            or triggers.get("push") != {"branches": ["master"]}):
        errors.append("CI workflow triggers must be pull_request and master push only")
    if workflow.get("permissions") != {"contents": "read"}:
        errors.append("CI workflow permissions must remain contents: read")
    jobs = workflow.get("jobs")
    if not isinstance(jobs, dict) or set(jobs) != {"validate"}:
        errors.append("CI workflow must have one validate job")
        return
    job = jobs["validate"]
    if not isinstance(job, dict):
        errors.append("CI validate job must be a mapping")
        return
    if (job.get("runs-on") != "ubuntu-latest"
            or job.get("timeout-minutes") != "15"
            or job.get("if") is not None
            or job.get("continue-on-error") is not None):
        errors.append("CI validate job cannot skip or weaken required validation")
    steps = job.get("steps")
    if not isinstance(steps, list) or len(steps) != 7 or not all(isinstance(step, dict) for step in steps):
        errors.append("CI workflow must retain the seven validation steps")
        return
    expected_actions = ["checkout", "setup-python"]
    for step, action in zip(steps[:2], expected_actions):
        use = step.get("uses", "")
        if not isinstance(use, str) or not re.fullmatch(
            rf"actions/{action}@[0-9a-fA-F]{{40}}", use
        ):
            errors.append(f"CI action {action} must be pinned to a full commit SHA")
    if steps[0].get("with", {}).get("persist-credentials") != "false":
        errors.append("CI checkout must not persist credentials")
    expected_commands = [
        "python -m pip install --disable-pip-version-check PyYAML==6.0.3",
        "python scripts/validate_definitions.py",
        "python scripts/run_tests.py",
        "git archive --format=zip --output=dandori-release.zip HEAD",
        "python scripts/validate_release_archive.py dandori-release.zip",
    ]
    if [step.get("run") for step in steps[2:]] != expected_commands:
        errors.append("CI workflow may not replace or skip required validation commands")
    if any("if" in step or "continue-on-error" in step or "shell" in step for step in steps):
        errors.append("CI steps may not use conditional skips, ignored errors or shell overrides")

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

    agent_tools: dict[str, list[str]] = {}
    for name in NAMES:
        path = root / ".copilot/agents" / (name + ".agent.md")
        if not path.is_file():
            continue
        meta, body = read_agent(path, errors)
        require(meta.get("name") == name and meta.get("target") == "github-copilot",
                f"{name}: invalid Copilot-only agent identity or target", errors)
        require("agents" not in meta and "handoffs" not in meta,
                f"{name}: Local-harness agent fields are forbidden", errors)
        require(meta.get("user-invocable") is (name == "Orchestrator"),
                f"{name}: invalid invocability", errors)
        require(meta.get("disable-model-invocation") is (name == "Orchestrator"),
                f"{name}: invalid Copilot model invocation policy", errors)
        hooks = meta.get("hooks")
        require(isinstance(hooks, dict) and "preToolUse" in hooks,
                f"{name}: scoped Copilot Hook is required", errors)
        if isinstance(hooks, dict):
            expected_hook = "orchestrator-guard.mjs" if name == "Orchestrator" else "hook.mjs"
            expected_command = "node ~/.copilot/skills/command-runner/scripts/" + expected_hook
            hook_entries = hooks.get("preToolUse")
            expected_timeout = 5 if name == "Orchestrator" else 30
            require(isinstance(hook_entries, list) and len(hook_entries) == 1
                    and isinstance(hook_entries[0], dict)
                    and hook_entries[0].get("type") == "command"
                    and hook_entries[0].get("command") == expected_command
                    and hook_entries[0].get("timeoutSec") == expected_timeout
                    and "PreToolUse" not in hooks,
                    f"{name}: exact scoped Hook command is required", errors)
        tools = meta.get("tools")
        require(isinstance(tools, list) and len(tools) == len(set(tools)),
                f"{name}: tools must be a unique list", errors)
        if not isinstance(tools, list):
            continue
        agent_tools[name] = tools
        require(not any(tool == "execute/runInTerminal" or tool == "agent"
                        for tool in tools),
                f"{name}: Local-harness tool aliases are forbidden", errors)
        if name == "Orchestrator":
            for needed in ("task", "store_memory", "vote_memory", "read_memories"):
                require(needed in tools, "Orchestrator: missing delegation or memory tool " + needed, errors)
            require(meta.get("skills") == ["task-reflection"],
                    "Orchestrator: must preload task-reflection Skill", errors)
            for marker in (
                "Missing permission is denied.", "Task Flow Review",
                "Task Flow Change", "APPROVE:TFR-", "APPROVE:TFC-",
                "normalized patches", "Contract revision", "## Worker selection",
                "reviewer", "parallel", "Host approval",
            ):
                require(marker.lower() in body.lower(),
                        "Orchestrator: missing policy " + marker, errors)
            for marker in (
                "### Task Flow Review: TFR-<unique-id>",
                "**Completion criteria**", "**Authorized capabilities**",
                "**Verification**", "**Reapproval boundary**",
                "Each GitHub mutation also requires individual Host approval",
                "### Task Flow Change: TFC-<unique-id>",
                "**Changed fields**", "**Unchanged**",
            ):
                require(marker in body,
                        "Orchestrator: missing human-readable review layout " + marker, errors)
            for review_type in ("TFR", "TFC"):
                token = "APPROVE:" + review_type + "-<unique-id>"
                require("```text\n" + token + "\n```" in body,
                        "Orchestrator: approval token must be a fenced text block for " + review_type, errors)
            delegation = body.split("## Delegation\n", 1)[-1].split("\n## Worker selection", 1)[0]
            require("Delegate exactly one fenced `yaml` block with top-level `task`" in delegation,
                    "Orchestrator: missing fenced YAML Task Card delegation rule", errors)
            card_match = re.search(r"(?ms)^```yaml\n(.*?)^```[ \t]*$", delegation)
            require(card_match is not None,
                    "Orchestrator: Task Card must be a fenced YAML block", errors)
            if card_match is not None:
                try:
                    card = yaml.safe_load(card_match.group(1))
                except yaml.YAMLError:
                    card = None
                task = card.get("task") if isinstance(card, dict) and set(card) == {"task"} else None
                require(isinstance(task, dict) and set(task) ==
                        {"id", "revision", "objective", "scope", "grants", "context", "deliver"}
                        and isinstance(task.get("id"), str)
                        and type(task.get("revision")) is int
                        and isinstance(task.get("objective"), str)
                        and isinstance(task.get("scope"), dict)
                        and all(isinstance(task.get(key), list) for key in ("grants", "context", "deliver")),
                        "Orchestrator: invalid Task Card YAML template structure", errors)
        elif name == "Executor":
            require(meta.get("skills") == ["command-runner", "test-design"],
                    "Executor: command-runner and test-design Skills required", errors)
            for expected_tool in ("read", "search", "web", "edit", "execute",
                                  "browser/readPage", "github/create_pull_request"):
                require(expected_tool in tools, "Executor: missing tool " + expected_tool, errors)
            require("Do not execute raw project commands" in body,
                    "Executor: fixed runner policy missing", errors)
        else:
            require("execute" in tools,
                    "Reviewer: fixed CommandRunner execution required", errors)
            require(meta.get("skills") == ["command-runner", "code-review"],
                    "Reviewer: command-runner and code-review Skills required", errors)
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

    verification_markers = {
        "Orchestrator": ("HEAD alone does not cover uncommitted changes",
                         "reuse still-applicable evidence"),
        "Executor": ("verification proportionate", "never claim an unexecuted check passed",
                     "HEAD alone does not represent uncommitted edits"),
        "Reviewer": ("Anchor your verdict", "HEAD alone does not capture uncommitted edits",
                     "recheck affected differences"),
    }
    for name, markers in verification_markers.items():
        path = root / ".copilot/agents" / (name + ".agent.md")
        if path.is_file():
            _, body = read_agent(path, errors)
            for marker in markers:
                require(marker.lower() in body.lower(),
                        f"{name}: missing verification evidence policy {marker}", errors)

    atomic_command_markers = {
        "Orchestrator": "A registered CommandRunner `run` is one authorized operation",
        "Executor": "Treat an authorized registered command as one operation",
        "Reviewer": "command-internal logs, caches, temporary files and cleanup are part of the run permission",
    }
    for name, marker in atomic_command_markers.items():
        path = root / ".copilot/agents" / (name + ".agent.md")
        if path.is_file():
            require(marker in path.read_text(),
                    f"{name}: missing atomic command authorization policy", errors)

    skill = root / ".copilot/skills/command-runner/SKILL.md"
    if skill.is_file():
        text = skill.read_text()
        for marker in ("An approved registered `run` authorizes the command as one operation",
                       "automatically prunes managed logs older than 24 hours"):
            require(marker in text, "command-runner: missing atomic run or cleanup guidance", errors)
        require("Normal `run` never deletes old caches" not in text,
                "command-runner: obsolete cache cleanup guidance", errors)

    troubleshooting = root / ".copilot/skills/command-runner/references/troubleshooting.md"
    if troubleshooting.is_file():
        text = troubleshooting.read_text()
        require("normal `run` automatically prunes managed execution logs" in text,
                "command-runner: outdated troubleshooting cleanup guidance", errors)
        require("normal `run` preserves old logs" not in text,
                "command-runner: obsolete troubleshooting cleanup guidance", errors)

    if all(name in agent_tools for name in NAMES):
        inherited = set(agent_tools["Executor"]) | set(agent_tools["Reviewer"])
        required_parent = {"task", "store_memory", "vote_memory", "read_memories"} | inherited
        require(set(agent_tools["Orchestrator"]) == required_parent,
                "Orchestrator: temporary worker-tool union must remain complete and guarded", errors)

    for name in NAMES:
        source = root / ".copilot/agents" / (name + ".agent.md")
        bundle = root / "packages/copilot/agents" / (name + ".agent.md")
        if source.is_file() and bundle.is_file():
            require(source.read_bytes() == bundle.read_bytes(),
                    "outdated bundle file: copilot/agents/" + name + ".agent.md", errors)

    reflection = root / ".copilot/skills/task-reflection/SKILL.md"
    if reflection.is_file():
        reflection_meta, reflection_body = read_agent(reflection, errors)
        require(reflection_meta.get("name") == "task-reflection"
                and isinstance(reflection_meta.get("description"), str)
                and "allowed-tools" not in reflection_meta,
                "task-reflection: invalid Skill identity or elevated tool permissions", errors)
        for phrase in ("final audit", "Skip", "Contract", "Host approval",
                       "at most one", "not authority"):
            require(phrase.lower() in reflection_body.lower(),
                    "task-reflection: missing safety or selectivity rule " + phrase, errors)

    test_design = root / ".copilot/skills/test-design/SKILL.md"
    if test_design.is_file():
        test_design_meta, _ = read_agent(test_design, errors)
        require(test_design_meta.get("name") == "test-design"
                and isinstance(test_design_meta.get("description"), str)
                and test_design_meta.get("user-invocable") is False
                and "allowed-tools" not in test_design_meta,
                "test-design: invalid Skill identity or elevated tool permissions", errors)

    review = root / ".copilot/skills/code-review/SKILL.md"
    if review.is_file():
        review_meta, review_body = read_agent(review, errors)
        require(review_meta.get("name") == "code-review"
                and "allowed-tools" not in review_meta,
                "code-review: invalid Skill identity or elevated tool permissions", errors)
        for phrase in ("complete in-scope diff", "review questions", "targeted search",
                       "Expand the investigation", "narrow search",
                       "verification credibility", "modified criteria alone"):
            require(phrase.lower() in review_body.lower(),
                    "code-review: missing diff-first investigation rule " + phrase, errors)

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
        validate_ci_workflow(workflow, errors)

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
