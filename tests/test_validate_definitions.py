from __future__ import annotations

import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("dandori_definition_validator", ROOT / "scripts/validate_definitions.py")
assert SPEC and SPEC.loader
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)

class ValidatorMutationTests(unittest.TestCase):
    def make_repo(self):
        temp = tempfile.TemporaryDirectory()
        repo = Path(temp.name) / "repo"
        shutil.copytree(ROOT, repo, ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc"))
        return temp, repo

    def assert_invalid(self, repo: Path, text: str) -> None:
        errors = validator.validate_repository(repo).errors
        self.assertTrue(errors)
        self.assertTrue(any(text in value for value in errors), "\n".join(errors))

    def test_repository_is_valid(self):
        self.assertEqual([], validator.validate_repository(ROOT).errors)

    def test_missing_worker_definition(self):
        temp, repo = self.make_repo()
        with temp:
            (repo / ".copilot/agents/Executor.agent.md").unlink()
            self.assert_invalid(repo, "missing required repository file")

    def test_old_workers_are_not_bundled(self):
        temp, repo = self.make_repo()
        with temp:
            (repo / ".copilot/agents/Researcher.agent.md").write_text("legacy")
            self.assert_invalid(repo, "agent inventory must be")

    def test_parent_cannot_gain_edit_tool(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(path.read_text().replace("  - agent\n", "  - agent\n  - edit\n", 1))
            self.assert_invalid(repo, "only delegation and memory tools")

    def test_approval_boundary_marker_is_required(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(path.read_text().replace("Missing permission is denied.", "Missing permission is allowed.", 1))
            self.assert_invalid(repo, "Missing permission is denied.")

    def test_reviewer_cannot_edit_or_mutate_github(self):
        for tool in ("edit", "github/merge_pull_request"):
            with self.subTest(tool=tool):
                temp, repo = self.make_repo()
                with temp:
                    path = repo / ".copilot/agents/Reviewer.agent.md"
                    path.write_text(path.read_text().replace("agents: []\n", "  - " + tool + "\nagents: []\n", 1))
                    self.assert_invalid(repo, "Reviewer: write, browser and delegation tools forbidden")

    def test_reviewer_requires_fixed_runner(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Reviewer.agent.md"
            path.write_text(path.read_text().replace("  - execute/runInTerminal\n", "", 1))
            self.assert_invalid(repo, "Reviewer: fixed CommandRunner execution required")

    def test_executor_requires_edit_tool(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Executor.agent.md"
            path.write_text(path.read_text().replace("  - edit\n", "", 1))
            self.assert_invalid(repo, "Executor: missing tool edit")

    def test_agent_bundle_drift(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / "packages/copilot/agents/Executor.agent.md"
            path.write_text(path.read_text() + "unexpected\n")
            self.assert_invalid(repo, "outdated bundle file")

    def test_skill_bundle_drift(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / "packages/copilot/skills/command-runner/SKILL.md"
            path.write_text(path.read_text() + "unexpected\n")
            self.assert_invalid(repo, "outdated bundle files")

    def test_missing_scoped_hook(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Executor.agent.md"
            path.write_text(path.read_text().replace("  PreToolUse:", "  PreToolUseLost:", 1))
            self.assert_invalid(repo, "scoped Hook is required")

    def test_symlink_is_rejected(self):
        temp, repo = self.make_repo()
        with temp:
            (repo / "unsafe-link").symlink_to(repo / "README.md")
            self.assert_invalid(repo, "repository symlinks are forbidden")

    def test_missing_readme_is_rejected(self):
        temp, repo = self.make_repo()
        with temp:
            (repo / "README.md").unlink()
            self.assert_invalid(repo, "missing required repository file")

    def test_ci_validation_required(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(path.read_text().replace("python scripts/validate_definitions.py", "echo skipped", 1))
            self.assert_invalid(repo, "CI workflow missing python scripts/validate_definitions.py")

if __name__ == "__main__":
    unittest.main()
