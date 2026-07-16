from __future__ import annotations

import importlib.util
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("dandori_validator", ROOT / "scripts" / "validate_definitions.py")
assert SPEC and SPEC.loader
validator = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = validator
SPEC.loader.exec_module(validator)


class ValidatorMutationTests(unittest.TestCase):
    def make_repo(self) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temp = tempfile.TemporaryDirectory()
        repo = Path(temp.name) / "repo"
        shutil.copytree(ROOT, repo, ignore=shutil.ignore_patterns(".git", "__pycache__"))
        return temp, repo

    def assert_valid(self, repo: Path) -> None:
        result = validator.validate_repository(repo)
        self.assertEqual([], result.errors, "\n".join(result.errors))

    def assert_invalid(self, repo: Path, needle: str) -> None:
        result = validator.validate_repository(repo)
        self.assertTrue(result.errors, "expected validation failure")
        self.assertTrue(any(needle in error for error in result.errors), "\n".join(result.errors))

    def test_repository_is_valid(self) -> None:
        self.assert_valid(ROOT)

    def test_orchestrator_rejects_edit_tool(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            text = path.read_text().replace("tools:\n", "tools:\n  - edit/editFiles\n", 1)
            path.write_text(text)
            self.assert_invalid(repo, "Orchestrator tools must be exactly")

    def test_worker_rejects_agent_tool(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Writer.agent.md"
            text = path.read_text().replace("tools:\n", "tools:\n  - agent\n", 1)
            path.write_text(text)
            self.assert_invalid(repo, "worker must not include the agent tool")

    def test_missing_description_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Researcher.agent.md"
            text = path.read_text().replace(
                "description: Investigate the codebase and return compact implementation-relevant facts. Does not edit, plan globally, or call other agents.\n",
                "",
                1,
            )
            path.write_text(text)
            self.assert_invalid(repo, "missing non-empty description")

    def test_duplicate_tool_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Reviewer.agent.md"
            text = path.read_text().replace("  - read/problems\n", "  - read/problems\n  - read/problems\n", 1)
            path.write_text(text)
            self.assert_invalid(repo, "tools contain duplicates")

    def test_missing_skills_directory_is_controlled_error(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            shutil.rmtree(repo / ".copilot/skills")
            self.assert_invalid(repo, "missing .copilot/skills directory")

    def test_external_allowlisted_agent_is_allowed(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            text = path.read_text().replace(
                "agents: [Researcher, PullRequestResearcher, Writer, Reviewer, BrowserQA]",
                "agents: [Researcher, PullRequestResearcher, Writer, Reviewer, BrowserQA, ExternalWorker]",
                1,
            )
            path.write_text(text)
            result = validator.validate_repository(repo)
            self.assertEqual([], result.errors, "\n".join(result.errors))
            self.assertTrue(any("ExternalWorker" in warning for warning in result.warnings))

    def test_missing_bundled_worker_from_allowlist_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            text = path.read_text().replace(", BrowserQA]", "]", 1)
            path.write_text(text)
            self.assert_invalid(repo, "bundled workers missing from allowlist")

    def test_target_and_orchestrator_tools_are_always_enforced(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Researcher.agent.md"
            path.write_text(path.read_text().replace("target: vscode\n", "target: github-copilot\n", 1))
            self.assert_invalid(repo, "agent must set target: vscode")

    def test_contract_requires_all_markers(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(path.read_text().replace("criterion_refs:\n", "", 1))
            self.assert_invalid(repo, "missing required Orchestrator marker")

    def test_removing_all_contract_activation_markers_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            text = path.read_text()
            text = text.replace("**Authorized operations**", "**Work boundaries**")
            text = text.replace("normalized_patch:\n", "")
            text = text.replace("criterion_refs:\n", "acceptance:\n")
            path.write_text(text)
            self.assert_invalid(repo, "missing required Orchestrator marker")

    def test_reverting_all_runtime_controls_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            agents_dir = repo / ".copilot/agents"
            for path in agents_dir.glob("*.agent.md"):
                text = path.read_text().replace("target: vscode\n", "")
                if path.name == "Orchestrator.agent.md":
                    text = text.replace("user-invocable: true\n", "")
                    text = text.replace("disable-model-invocation: true\n", "")
                    text = text.replace("tools:\n  - agent\n", "tools:\n  - agent\n  - read/readFile\n", 1)
                path.write_text(text)
            self.assert_invalid(repo, "agent must set target: vscode")

    def test_legacy_generic_limit_marker_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            text = path.read_text().replace("set_auto_added_targets_max:", "set_limits:", 1)
            path.write_text(text)
            self.assert_invalid(repo, "forbidden legacy marker 'set_limits:'")

    def test_skill_link_breakage_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Reviewer.agent.md"
            path.write_text(path.read_text().replace("../skills/code-review/SKILL.md", "../skills/code-review/MISSING.md"))
            self.assert_invalid(repo, "missing relative link target")

    def test_agent_body_length_limit(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(path.read_text() + ("x" * 30_001))
            self.assert_invalid(repo, "agent body exceeds")


if __name__ == "__main__":
    unittest.main()
