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
            path.write_text(path.read_text().replace("  - task\n", "  - task\n  - unauthorized_tool\n", 1))
            self.assert_invalid(repo, "temporary worker-tool union must remain complete and guarded")

    def test_approval_boundary_marker_is_required(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(path.read_text().replace("Missing permission is denied.", "Missing permission is allowed.", 1))
            self.assert_invalid(repo, "Missing permission is denied.")

    def test_orchestrator_requires_readable_tfr_and_tfc_layout(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            content = path.read_text()
            self.assertIn("### Task Flow Review: TFR-<unique-id>", content)
            path.write_text(content.replace("### Task Flow Review: TFR-<unique-id>",
                                           "Plain TFR paragraph", 1))
            self.assert_invalid(repo, "missing human-readable review layout")

    def test_orchestrator_requires_copyable_approval_tokens(self):
        for review_type in ("TFR", "TFC"):
            with self.subTest(review_type=review_type):
                temp, repo = self.make_repo()
                with temp:
                    path = repo / ".copilot/agents/Orchestrator.agent.md"
                    content = path.read_text()
                    token = "APPROVE:" + review_type + "-<unique-id>"
                    fenced = "```text\n" + token + "\n```"
                    self.assertIn(fenced, content)
                    path.write_text(content.replace(fenced, token, 1))
                    self.assert_invalid(repo, "approval token must be a fenced text block")

    def test_orchestrator_requires_fenced_worker_task_card(self):
        mutations = (
            ("```yaml\ntask:\n", "task:\n", "Task Card must be a fenced YAML block"),
            ("Delegate exactly one fenced `yaml` block with top-level `task`",
             "Delegate a task", "missing fenced YAML Task Card delegation rule"),
        )
        for original, replacement, expected_error in mutations:
            with self.subTest(original=original):
                temp, repo = self.make_repo()
                with temp:
                    path = repo / ".copilot/agents/Orchestrator.agent.md"
                    content = path.read_text()
                    self.assertIn(original, content)
                    path.write_text(content.replace(original, replacement, 1))
                    self.assert_invalid(repo, expected_error)

    def test_orchestrator_preserves_task_card_yaml_value_types(self):
        for original, replacement in (
            ("  scope: {}", '  scope: "free prose"'),
            ("  grants: []  # narrowed complete subset of approved capabilities",
             '  grants: "free prose"'),
            ("  context: []", '  context: "free prose"'),
        ):
            with self.subTest(field=original):
                temp, repo = self.make_repo()
                with temp:
                    path = repo / ".copilot/agents/Orchestrator.agent.md"
                    content = path.read_text()
                    self.assertIn(original, content)
                    path.write_text(content.replace(original, replacement, 1))
                    self.assert_invalid(repo, "invalid Task Card YAML template structure")

    def test_registered_command_authorization_is_atomic(self):
        markers = {
            "Orchestrator": "A registered CommandRunner `run` is one authorized operation",
            "Executor": "Treat an authorized registered command as one operation",
            "Reviewer": "command-internal logs, caches, temporary files and cleanup are part of the run permission",
        }
        for name, marker in markers.items():
            with self.subTest(agent=name):
                temp, repo = self.make_repo()
                with temp:
                    path = repo / ".copilot/agents" / (name + ".agent.md")
                    content = path.read_text()
                    self.assertIn(marker, content)
                    path.write_text(content.replace(marker, "requires individual effect authorization", 1))
                    self.assert_invalid(repo, "missing atomic command authorization policy")

    def test_command_runner_cleanup_guidance_matches_runner(self):
        mutations = (
            (".copilot/skills/command-runner/SKILL.md",
             "automatically prunes managed logs older than 24 hours",
             "never deletes previously cached logs",
             "command-runner: missing atomic run or cleanup guidance"),
            (".copilot/skills/command-runner/references/troubleshooting.md",
             "normal `run` automatically prunes managed execution logs",
             "normal `run` preserves old logs",
             "command-runner: outdated troubleshooting cleanup guidance"),
            (".copilot/skills/command-runner/references/commands.md",
             "Normal `run` automatically removes managed execution logs older than 24 hours",
             "Normal `run` never deletes old logs",
             "command-runner: outdated command reference cleanup guidance"),
        )
        for relative, marker, replacement, expected in mutations:
            with self.subTest(path=relative):
                temp, repo = self.make_repo()
                with temp:
                    path = repo / relative
                    content = path.read_text()
                    self.assertIn(marker, content)
                    path.write_text(content.replace(marker, replacement, 1))
                    self.assert_invalid(repo, expected)

    def test_reviewer_cannot_edit_or_mutate_github(self):
        for tool in ("edit", "github/merge_pull_request"):
            with self.subTest(tool=tool):
                temp, repo = self.make_repo()
                with temp:
                    path = repo / ".copilot/agents/Reviewer.agent.md"
                    path.write_text(path.read_text().replace("  - execute\n", "  - execute\n  - " + tool + "\n", 1))
                    self.assert_invalid(repo, "Reviewer: write, browser and delegation tools forbidden")

    def test_reviewer_requires_fixed_runner(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Reviewer.agent.md"
            path.write_text(path.read_text().replace("  - execute\n", "", 1))
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
            path.write_text(path.read_text().replace("  preToolUse:", "  preToolUseLost:", 1))
            self.assert_invalid(repo, "scoped Copilot Hook is required")

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
            self.assert_invalid(repo, "CI workflow may not replace or skip required validation commands")


    def test_reviewer_declares_code_review_skill(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / "packages/copilot/agents/Reviewer.agent.md"
            path.write_text(path.read_text().replace("  - code-review\n", "", 1))
            self.assert_invalid(repo, "outdated bundle file")

    def test_ci_write_permissions_are_rejected(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(path.read_text().replace("contents: read", "contents: write", 1))
            self.assert_invalid(repo, "CI workflow permissions")

    def test_ci_unpinned_action_is_rejected(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            text = path.read_text()
            import re
            path.write_text(re.sub(r"actions/checkout@[a-f0-9]{40}", "actions/checkout@main", text, count=1))
            self.assert_invalid(repo, "pinned to a full commit SHA")

    def test_ci_target_event_is_rejected(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(path.read_text().replace("  pull_request:", "  pull_request_target:", 1))
            self.assert_invalid(repo, "CI workflow triggers")

    def test_ci_shell_injection_is_rejected(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(path.read_text().replace(
                "run: python scripts/validate_definitions.py",
                "run: python scripts/validate_definitions.py; echo bypass", 1))
            self.assert_invalid(repo, "required validation commands")

    def test_replaced_hook_command_is_rejected(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Executor.agent.md"
            path.write_text(path.read_text().replace(
                "command: node ~/.copilot/skills/command-runner/scripts/hook.mjs",
                "command: node ~/.copilot/skills/command-runner/scripts/noop.mjs", 1))
            self.assert_invalid(repo, "exact scoped Hook command is required")


    def test_local_target_is_rejected(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Executor.agent.md"
            path.write_text(path.read_text().replace(
                "target: github-copilot", "target: vscode", 1))
            self.assert_invalid(repo, "invalid Copilot-only agent identity or target")

    def test_local_tool_alias_is_rejected(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Executor.agent.md"
            path.write_text(path.read_text().replace(
                "  - execute\n", "  - execute/runInTerminal\n", 1))
            self.assert_invalid(repo, "Local-harness tool aliases are forbidden")

    def test_orchestrator_reflection_skill_cannot_be_removed(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(path.read_text().replace(
                "skills:\n  - task-reflection\n", "", 1))
            self.assert_invalid(repo, "must preload task-reflection Skill")

    def test_executor_requires_test_design_skill(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Executor.agent.md"
            path.write_text(path.read_text().replace("  - test-design\n", "", 1))
            self.assert_invalid(repo, "Executor: command-runner and test-design Skills required")

    def test_test_design_skill_cannot_grant_tools(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/skills/test-design/SKILL.md"
            path.write_text(path.read_text().replace(
                "user-invocable: false\n",
                "user-invocable: false\nallowed-tools: [execute]\n", 1))
            self.assert_invalid(repo, "test-design: invalid Skill identity or elevated tool permissions")

    def test_reflection_skill_must_exist(self):
        temp, repo = self.make_repo()
        with temp:
            (repo / ".copilot/skills/task-reflection/SKILL.md").unlink()
            self.assert_invalid(repo, "missing required repository file")

    def test_reflection_skill_cannot_grant_tools(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/skills/task-reflection/SKILL.md"
            path.write_text(path.read_text().replace(
                "user-invocable: false\n",
                "user-invocable: false\nallowed-tools: [store_memory]\n", 1))
            self.assert_invalid(repo, "elevated tool permissions")

    def test_reflection_skill_bundle_drift(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / "packages/copilot/skills/task-reflection/SKILL.md"
            path.write_text(path.read_text() + "\nunauthorized\n")
            self.assert_invalid(repo, "outdated bundle files")

    def test_copilot_agents_are_distributed_without_transformation(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / "packages/copilot/agents/Orchestrator.agent.md"
            path.write_text(path.read_text().replace(
                "target: github-copilot", "target: vscode", 1))
            self.assert_invalid(repo, "outdated bundle file")

    def test_parent_cannot_drop_workaround_tool_union(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(path.read_text().replace(
                "  - github/get_file_contents\n", "", 1))
            self.assert_invalid(repo, "temporary worker-tool union")


    def test_reviewer_diff_first_guidance_is_required(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/skills/code-review/SKILL.md"
            path.write_text(path.read_text().replace(
                "Use targeted search to locate relevant callers, dependencies and tests; ",
                "", 1))
            self.assert_invalid(repo, "code-review: missing diff-first investigation rule targeted search")

    def test_verification_evidence_policies_cannot_be_removed(self):
        markers = {
            "Orchestrator": "HEAD alone does not cover uncommitted changes",
            "Executor": "never claim an unexecuted check passed",
            "Reviewer": "HEAD alone does not capture uncommitted edits",
        }
        for name, marker in markers.items():
            with self.subTest(agent=name):
                temp, repo = self.make_repo()
                with temp:
                    path = repo / ".copilot/agents" / (name + ".agent.md")
                    content = path.read_text()
                    self.assertIn(marker, content)
                    path.write_text(content.replace(marker, "omitted verification", 1))
                    self.assert_invalid(repo, "missing verification evidence policy")

    def test_review_skill_checks_weakened_verification(self):
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/skills/code-review/SKILL.md"
            content = path.read_text()
            self.assertIn("verification credibility", content)
            path.write_text(content.replace("verification credibility", "test status", 1))
            self.assert_invalid(repo, "missing diff-first investigation rule verification credibility")

if __name__ == "__main__":
    unittest.main()
