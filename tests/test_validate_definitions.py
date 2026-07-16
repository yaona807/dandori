from __future__ import annotations

import importlib.util
import re
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
            self.assert_invalid(repo, "Orchestrator")

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

    def make_runtime_v2(self, repo: Path) -> None:
        agents_dir = repo / ".copilot/agents"
        browser_old = agents_dir / "BrowserQa.agent.md"
        browser_new = agents_dir / "BrowserQA.agent.md"
        if browser_old.exists():
            browser_old.rename(browser_new)
            for readme in (repo / "README.md", repo / "README_ja.md"):
                readme.write_text(readme.read_text().replace("BrowserQa.agent.md", "BrowserQA.agent.md"))
        for path in agents_dir.glob("*.agent.md"):
            text = path.read_text()
            head, separator, body = text.partition("---\n\n")
            if not separator:
                raise AssertionError(f"invalid fixture frontmatter: {path}")
            if "target:" in head:
                head = re.sub(r"^target:.*$", "target: vscode", head, flags=re.MULTILINE)
            else:
                head = head.replace("model: Auto (copilot)\n", "model: Auto (copilot)\ntarget: vscode\n", 1)
            if path.name == "Orchestrator.agent.md":
                if "user-invocable:" in head:
                    head = re.sub(r"^user-invocable:.*$", "user-invocable: true", head, flags=re.MULTILINE)
                else:
                    head = head.replace("target: vscode\n", "target: vscode\nuser-invocable: true\n", 1)
                if "disable-model-invocation:" in head:
                    head = re.sub(
                        r"^disable-model-invocation:.*$",
                        "disable-model-invocation: true",
                        head,
                        flags=re.MULTILINE,
                    )
                else:
                    head = head.replace(
                        "user-invocable: true\n",
                        "user-invocable: true\ndisable-model-invocation: true\n",
                        1,
                    )
                head = re.sub(r"tools:\n(?:  - .*\n)+agents:", "tools:\n  - agent\nagents:", head)
            path.write_text(head + separator + body)

    def test_runtime_v2_validates_target_and_orchestrator_tools(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            self.make_runtime_v2(repo)
            self.assert_valid(repo)
            path = repo / ".copilot/agents/Researcher.agent.md"
            path.write_text(path.read_text().replace("target: vscode\n", "target: github-copilot\n", 1))
            self.assert_invalid(repo, "runtime-v2 agent must set target: vscode")

    def make_contract_v2_body(self, repo: Path) -> None:
        path = repo / ".copilot/agents/Orchestrator.agent.md"
        text = path.read_text()
        frontmatter, _, _body = text.partition("---\n\n")
        body = """Contract policy fixture.\n\n**Authorized operations**\n\n```yaml\nnormalized_patch:\ncompletion_criteria:\nverification_requirements:\ncriterion_refs:\nexpected_delta:\n```\n\n**Contract patch**\n"""
        path.write_text(frontmatter + "---\n\n" + body)

    def test_contract_v2_requires_all_markers(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            self.make_contract_v2_body(repo)
            self.assert_valid(repo)
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(path.read_text().replace("criterion_refs:\n", "", 1))
            self.assert_invalid(repo, "missing contract-v2 marker")

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
