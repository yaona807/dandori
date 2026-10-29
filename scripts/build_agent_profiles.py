#!/usr/bin/env python3
"""Build and verify committed VS Code Local / GitHub Copilot agent bundles."""
from __future__ import annotations
import argparse
import difflib
from pathlib import Path
import shutil
import tempfile
import yaml

ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / ".copilot" / "agents"
WORKERS = ("Researcher", "GitHubResearcher", "Writer", "CommandRunner", "Reviewer", "BrowserQA")
NAMES = ("Orchestrator", *WORKERS)
COPILOT_MODELS = {
    "Orchestrator": "gpt-6.1-sol",
    "Reviewer": "gpt-6.1-sol",
    "Writer": "gpt-6.1-terra",
    "BrowserQA": "gpt-6.1-terra",
    "Researcher": "gpt-6-luna",
    "GitHubResearcher": "gpt-6-luna",
    "CommandRunner": "gpt-6-luna",
}

def transform(source: str, name: str, profile: str) -> str:
    if not source.startswith("---\n"):
        raise ValueError(f"{name}: missing frontmatter")
    _, front, body = source.split("---\n", 2)
    meta = yaml.safe_load(front)
    if meta.get("name") != name:
        raise ValueError(f"{name}: name mismatch")
    if profile == "copilot":
        meta["target"] = "github-copilot"
        meta["model"] = COPILOT_MODELS[name]
        meta.pop("agents", None)
        if name in WORKERS:
            meta["disable-model-invocation"] = False
        if name == "Orchestrator":
            meta["tools"] = ["agent"]
    elif profile != "local":
        raise ValueError(profile)
    return "---\n" + yaml.safe_dump(meta, allow_unicode=True, sort_keys=False, width=1000) + "---\n" + body

def generate(destination: Path) -> None:
    for profile in ("local", "copilot"):
        target = destination / profile
        for name in NAMES:
            original = (AGENTS / f"{name}.agent.md").read_text(encoding="utf-8")
            output = target / "agents" / f"{name}.agent.md"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(transform(original, name, profile), encoding="utf-8")
        for directory in ("skills", "command-runner"):
            source = ROOT / ".copilot" / directory
            if source.exists():
                shutil.copytree(source, target / directory, dirs_exist_ok=True)

def compare(expected: Path, actual: Path) -> list[str]:
    errors = []
    expected_files = {p.relative_to(expected) for p in expected.rglob("*") if p.is_file()}
    actual_files = {p.relative_to(actual) for p in actual.rglob("*") if p.is_file()}
    for path in sorted(expected_files ^ actual_files):
        errors.append(f"missing or unexpected bundle file: {path}")
    for path in sorted(expected_files & actual_files):
        if (expected / path).read_bytes() != (actual / path).read_bytes():
            errors.append(f"outdated bundle file: {path}")
    return errors

def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.write:
        target = ROOT / "packages"
        if target.exists():
            shutil.rmtree(target)
        generate(target)
        return 0
    with tempfile.TemporaryDirectory() as directory:
        expected = Path(directory)
        generate(expected)
        errors = compare(expected, ROOT / "packages")
        for error in errors:
            print(error)
        return 1 if errors else 0

if __name__ == "__main__":
    raise SystemExit(main())
