#!/usr/bin/env python3
"""Build and verify the GitHub Copilot-only DANDORI distribution.

The .copilot/agents definitions are already Copilot profiles; do not
translate Local/VS Code frontmatter or invent a second agent schema.
"""
from __future__ import annotations

import argparse
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGENTS = ("Orchestrator", "Executor", "Reviewer")

def generate(destination: Path) -> None:
    bundle = destination / "copilot"
    agent_dir = bundle / "agents"
    agent_dir.mkdir(parents=True, exist_ok=True)
    for name in AGENTS:
        source = ROOT / ".copilot" / "agents" / (name + ".agent.md")
        shutil.copyfile(source, agent_dir / source.name)
    shutil.copytree(ROOT / ".copilot" / "skills", bundle / "skills", dirs_exist_ok=True)

def compare(expected: Path, actual: Path) -> list[str]:
    generated = {p.relative_to(expected): p for p in expected.rglob("*") if p.is_file()}
    installed = {p.relative_to(actual): p for p in actual.rglob("*") if p.is_file()}
    return (
        [f"missing or unexpected bundle file: {p}" for p in sorted(generated.keys() ^ installed.keys())]
        + [f"outdated bundle file: {p}" for p in sorted(generated.keys() & installed.keys())
           if generated[p].read_bytes() != installed[p].read_bytes()]
    )

def main() -> int:
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--write", action="store_true")
    modes.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.write:
        shutil.rmtree(ROOT / "packages", ignore_errors=True)
        generate(ROOT / "packages")
        return 0
    with tempfile.TemporaryDirectory() as directory:
        expected = Path(directory)
        generate(expected)
        problems = compare(expected, ROOT / "packages")
        for problem in problems:
            print(problem)
        return bool(problems)

if __name__ == "__main__":
    raise SystemExit(main())
