#!/usr/bin/env python3
"""Build and verify the three Copilot agent profiles."""
from __future__ import annotations
import argparse
from pathlib import Path
import re
import shutil
import tempfile
import yaml

ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / ".copilot/agents"
WORKERS = ("Executor", "Reviewer")
NAMES = ("Orchestrator", *WORKERS)
GITHUB_READ = "get_me search_repositories pull_request_read list_pull_requests search_pull_requests issue_read list_issues search_issues actions_get actions_list get_job_logs get_file_contents get_commit list_branches list_commits search_code search_commits".split()
GITHUB_WRITE = "create_pull_request update_pull_request update_pull_request_branch merge_pull_request pull_request_review_write add_comment_to_pending_review add_reply_to_pull_request_comment issue_write add_issue_comment update_issue_comment actions_run_trigger create_branch request_copilot_review".split()
BROWSER = "readPage screenshotPage clickElement hoverElement dragElement typeInPage handleDialog".split()
READ = tuple("github/" + name for name in GITHUB_READ)
WRITE = tuple("github/" + name for name in GITHUB_WRITE)
BROWSER_TOOLS = tuple("browser/" + name for name in BROWSER)
TOOLS = {
    "Executor": ("read", "search", "web", "edit", "execute") + READ + WRITE + BROWSER_TOOLS,
    "Reviewer": ("read", "search", "execute") + READ,
}

def transform(source: str, name: str, profile: str = "copilot") -> str:
    if profile != "copilot" or not source.startswith("---\n"):
        raise ValueError("invalid profile")
    _, front, body = source.split("---\n", 2)
    if yaml.safe_load(front).get("name") != name or name not in NAMES:
        raise ValueError("invalid agent identity")
    front = re.sub(r"(?m)^(model: .+?) \(copilot\)$", r"\1", front)
    front = re.sub(r"(?m)^agents:.*\n", "", front)
    front = front.replace("target: vscode", "target: github-copilot")
    if name in WORKERS:
        front = front.replace("disable-model-invocation: true", "disable-model-invocation: false")
    exposed = (
        list(dict.fromkeys(("task", "store_memory", "vote_memory", "read_memories") + tuple(
            tool for worker in WORKERS for tool in TOOLS[worker]
        ))) if name == "Orchestrator" else TOOLS[name]
    )
    front, count = re.subn(r"(?m)^tools:\n(?:  - [^\n]+\n)+",
                           "tools:\n" + "".join("  - " + tool + "\n" for tool in exposed), front)
    if count != 1:
        raise ValueError("missing tools definition")
    hook_name = "orchestrator-guard" if name == "Orchestrator" else "hook"
    timeout = 5 if name == "Orchestrator" else 30
    old = (f"hooks:\n  PreToolUse:\n    - type: command\n"
           f"      command: node ~/.copilot/skills/command-runner/scripts/{hook_name}.mjs\n"
           f"      timeout: {timeout}\n")
    new = (f"hooks:\n  preToolUse:\n    - type: command\n"
           f"      command: node ~/.copilot/skills/command-runner/scripts/{hook_name}.mjs\n"
           f"      timeoutSec: {timeout}\n")
    if front.count(old) != 1:
        raise ValueError("missing scoped Hook")
    front = front.replace(old, new)
    if name in WORKERS:
        front += "skills:\n  - command-runner\n"
    return "---\n" + front + "---\n" + body

def generate(directory: Path) -> None:
    bundle = directory / "copilot"
    for name in NAMES:
        source = (AGENTS / (name + ".agent.md")).read_text(encoding="utf-8")
        target = bundle / "agents" / (name + ".agent.md")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(transform(source, name), encoding="utf-8")
    shutil.copytree(ROOT / ".copilot/skills", bundle / "skills", dirs_exist_ok=True)

def compare(expected: Path, current: Path) -> list[str]:
    a = {p.relative_to(expected): p for p in expected.rglob("*") if p.is_file()}
    b = {p.relative_to(current): p for p in current.rglob("*") if p.is_file()}
    return ([f"missing or unexpected bundle file: {p}" for p in sorted(a.keys() ^ b.keys())]
            + [f"outdated bundle file: {p}" for p in sorted(a.keys() & b.keys())
               if a[p].read_bytes() != b[p].read_bytes()])

def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.write:
        shutil.rmtree(ROOT / "packages", ignore_errors=True)
        generate(ROOT / "packages")
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        expected = Path(tmp)
        generate(expected)
        issues = compare(expected, ROOT / "packages")
        for issue in issues:
            print(issue)
        return bool(issues)

if __name__ == "__main__":
    raise SystemExit(main())
