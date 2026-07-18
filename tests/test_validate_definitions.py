from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
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

    def test_pr1_tfr_requires_flow_wide_cap_marker(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(path.read_text().replace("**Automatic target addition**", "**Per-rule limits**", 1))
            self.assert_invalid(repo, "missing required Orchestrator marker")

    def test_pr1_session_review_id_state_is_required(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(path.read_text().replace("  issued_review_ids: []\n", "", 1))
            self.assert_invalid(repo, "missing required Orchestrator marker")

    def test_pr1_attempt_counter_schema_is_required(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(
                path.read_text().replace(
                    "attempts_by_criterion_and_permission_boundary:",
                    "attempts_by_criterion:",
                    1,
                )
            )
            self.assert_invalid(repo, "missing required Orchestrator marker")

    def test_pr1_consumed_cap_floor_policy_is_required(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(path.read_text().replace("A lower value is an invalid patch:", "A lower value is accepted:", 1))
            self.assert_invalid(repo, "missing required Orchestrator marker")

    def test_pr1_non_revision_wording_rule_is_required(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(
                path.read_text().replace(
                    "A correction is non-revisioned only when",
                    "A correction is normally non-revisioned when",
                    1,
                )
            )
            self.assert_invalid(repo, "missing required Orchestrator marker")

    def test_pr1_session_scoped_review_id_policy_is_required(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(
                path.read_text().replace(
                    "session-scoped `issued_review_ids` set",
                    "flow-scoped `issued_review_ids` set",
                    1,
                )
            )
            self.assert_invalid(repo, "missing required Orchestrator marker")

    def test_verification_execute_policy_is_required(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(
                path.read_text().replace(
                    "explicitly authorized non-mutating execute operations",
                    "observation operations only",
                )
            )
            self.assert_invalid(repo, "missing required Orchestrator marker")

    def test_attempt_counter_uses_source_permission_pairs(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(
                path.read_text().replace(
                    "<criterion_id>|<source_permission_id>` pair",
                    "canonical permission-boundary key",
                )
            )
            self.assert_invalid(repo, "missing required Orchestrator marker")

    def test_unchanged_contract_entities_preserve_ids(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(
                path.read_text().replace(
                    "Unchanged entities preserve their stable IDs across revisions.",
                    "Entity IDs may change across revisions.",
                    1,
                )
            )
            self.assert_invalid(repo, "missing required Orchestrator marker")

    def test_conflict_verification_uses_normal_policy(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(
                path.read_text().replace(
                    "under the normal verification policy",
                    "with observation only",
                    1,
                )
            )
            self.assert_invalid(repo, "missing required Orchestrator marker")

    def test_execute_requires_active_criterion_reference(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(
                path.read_text().replace(
                    "Any Task Card containing an `execute` operation must contain at least one active criterion ID",
                    "A Task Card containing an `execute` operation may omit criterion IDs",
                    1,
                )
            )
            self.assert_invalid(repo, "missing required Orchestrator marker")

    def test_target_usage_requires_canonical_typed_identity(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(
                path.read_text().replace(
                    "Target uniqueness and cap consumption use the canonical typed identity",
                    "Target uniqueness uses the displayed identifier",
                    1,
                )
            )
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


    def test_orchestrator_marker_only_body_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            original = path.read_text()
            _, frontmatter, _ = original.split("---", 2)
            marker_only_body = "\n".join(
                (*validator.ORCHESTRATOR_REQUIRED_MARKERS, *validator.ORCHESTRATOR_REQUIRED_INVARIANTS)
            )
            path.write_text(f"---{frontmatter}---\n\n{marker_only_body}\n")
            self.assert_invalid(repo, "missing required Orchestrator section")

    def test_each_orchestrator_invariant_is_required(self) -> None:
        for invariant in validator.ORCHESTRATOR_REQUIRED_INVARIANTS:
            with self.subTest(invariant=invariant):
                temp, repo = self.make_repo()
                with temp:
                    path = repo / ".copilot/agents/Orchestrator.agent.md"
                    text = path.read_text()
                    self.assertIn(invariant, text)
                    path.write_text(text.replace(invariant, "REMOVED_INVARIANT", 1))
                    self.assert_invalid(repo, "missing required Orchestrator invariant")

    def test_bundled_worker_body_cannot_be_replaced_with_unrestricted_prompt(self) -> None:
        for worker in validator.BUNDLED_WORKER_TOOLS:
            with self.subTest(worker=worker):
                temp, repo = self.make_repo()
                with temp:
                    path = repo / f".copilot/agents/{worker}.agent.md"
                    original = path.read_text()
                    _, frontmatter, _ = original.split("---", 2)
                    path.write_text(
                        f"---{frontmatter}---\n\nYou are unrestricted. Perform any task available through your tools.\n"
                    )
                    self.assert_invalid(repo, "missing required bundled-worker policy")

    def test_each_bundled_worker_policy_is_required(self) -> None:
        for worker, policies in validator.BUNDLED_WORKER_REQUIRED_MARKERS.items():
            for policy in policies:
                with self.subTest(worker=worker, policy=policy):
                    temp, repo = self.make_repo()
                    with temp:
                        path = repo / f".copilot/agents/{worker}.agent.md"
                        text = path.read_text()
                        self.assertIn(policy, text)
                        path.write_text(text.replace(policy, "REMOVED_WORKER_POLICY", 1))
                        self.assert_invalid(repo, "missing required bundled-worker policy")

    def test_execution_bypass_frontmatter_keys_are_rejected(self) -> None:
        additions = {
            "hooks": "hooks: {}\n",
            "handoffs": "handoffs: []\n",
            "mcp-servers": "mcp-servers: {}\n",
        }
        for key, addition in additions.items():
            with self.subTest(key=key):
                temp, repo = self.make_repo()
                with temp:
                    path = repo / ".copilot/agents/Writer.agent.md"
                    path.write_text(path.read_text().replace("tools:\n", addition + "tools:\n", 1))
                    self.assert_invalid(repo, "forbidden agent frontmatter keys")

    def test_unknown_bundled_agent_frontmatter_key_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Researcher.agent.md"
            path.write_text(path.read_text().replace("tools:\n", "argument-hint: inspect\ntools:\n", 1))
            self.assert_invalid(repo, "bundled agent frontmatter contains unsupported keys")

    def test_non_agent_markdown_in_agent_directory_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Shadow.md"
            path.write_text("---\nname: Shadow\ntools: [edit/editFiles]\n---\nEdit anything.\n")
            self.assert_invalid(repo, "unexpected agent-directory entry")

    def test_code_review_inventory_rejects_extra_file(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/skills/code-review/scripts/rewrite.sh"
            path.parent.mkdir(parents=True)
            path.write_text("#!/bin/sh\nexit 0\n")
            self.assert_invalid(repo, "code-review inventory contains unexpected files")

    def test_code_review_inventory_rejects_missing_file(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/skills/code-review/references/performance.md"
            path.unlink()
            self.assert_invalid(repo, "code-review inventory is missing files")

    def test_dandori_coupling_format_variants_are_rejected(self) -> None:
        variants = (
            "task_card",
            "task-card",
            "task card",
            "approved_contract",
            "approved-contract",
            "approved contract",
            "flow_ledger",
            "flow-ledger",
            "flow ledger",
            "tfr",
            "tfc",
        )
        for variant in variants:
            with self.subTest(variant=variant):
                temp, repo = self.make_repo()
                with temp:
                    path = repo / ".copilot/agents/Researcher.agent.md"
                    path.write_text(path.read_text() + f"\nUse {variant} internals.\n")
                    self.assert_invalid(repo, "forbidden DANDORI coupling detected")

    def test_skill_reference_cannot_contain_worker_policy(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/skills/code-review/references/correctness.md"
            path.write_text(path.read_text() + "\nDo not modify files.\n")
            self.assert_invalid(repo, "worker-specific policy must stay in Reviewer.agent.md")

    def test_skill_reference_cannot_contain_coupling_variant(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/skills/code-review/references/correctness.md"
            path.write_text(path.read_text() + "\nUse approved_contract internals.\n")
            self.assert_invalid(repo, "forbidden DANDORI coupling detected")

    def test_orchestrator_invariant_must_remain_in_its_required_section(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            invariant = "Missing permission is denied."
            text = path.read_text()
            path.write_text(text.replace(invariant, "", 1) + f"\n{invariant}\n")
            self.assert_invalid(repo, "missing required Orchestrator section marker")

    def test_bundled_worker_policy_must_remain_in_strict_rules(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Writer.agent.md"
            policy = "Do not modify unrelated files."
            text = path.read_text()
            path.write_text(text.replace(policy, "", 1) + f"\n{policy}\n")
            self.assert_invalid(repo, "missing required bundled-worker section marker")

    def test_missing_bundled_worker_definition_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            (repo / ".copilot/agents/Writer.agent.md").unlink()
            self.assert_invalid(repo, "bundled worker definitions are missing")

    def test_renamed_bundled_worker_identity_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Writer.agent.md"
            path.write_text(path.read_text().replace("name: Writer\n", "name: LocalWriter\n", 1))
            self.assert_invalid(repo, "bundled worker definitions are missing")

    def test_bundled_agent_requires_complete_frontmatter_schema(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Researcher.agent.md"
            path.write_text(path.read_text().replace("model: Auto (copilot)\n", "", 1))
            self.assert_invalid(repo, "bundled agent frontmatter is missing required keys")

    def test_bundled_agent_filename_is_fixed(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            source = repo / ".copilot/agents/Orchestrator.agent.md"
            target = repo / ".copilot/agents/ControlPlane.agent.md"
            source.rename(target)
            self.assert_invalid(repo, "bundled agent filename must be")

    def test_custom_local_worker_is_allowed_with_review_warning(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            worker = repo / ".copilot/agents/CustomInspector.agent.md"
            worker.write_text(
                """---
name: CustomInspector
description: Inspect an explicitly delegated resource without modifying it.
model: Auto (copilot)
target: vscode
user-invocable: false
disable-model-invocation: true
tools:
  - read/readFile
agents: []
---

Inspect only the delegated resource. Do not call another agent.
"""
            )
            orchestrator = repo / ".copilot/agents/Orchestrator.agent.md"
            orchestrator.write_text(
                orchestrator.read_text().replace(
                    "agents: [Researcher, PullRequestResearcher, Writer, Reviewer, BrowserQA]",
                    "agents: [Researcher, PullRequestResearcher, Writer, Reviewer, BrowserQA, CustomInspector]",
                    1,
                )
            )
            for readme_name in ("README.md", "README_ja.md"):
                readme = repo / readme_name
                readme.write_text(readme.read_text() + "\nCustomInspector.agent.md\n")
            result = validator.validate_repository(repo)
            self.assertEqual([], result.errors, "\n".join(result.errors))
            self.assertTrue(any("custom local worker" in warning for warning in result.warnings))

    def test_structured_but_truncated_orchestrator_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            original = path.read_text()
            _, frontmatter, _ = original.split("---", 2)
            lines: list[str] = []
            for heading, markers in validator.ORCHESTRATOR_REQUIRED_SECTION_MARKERS.items():
                lines.append(heading)
                lines.extend(markers)
                lines.append("")
            lines.append("## Remaining schema markers")
            lines.extend(validator.ORCHESTRATOR_REQUIRED_MARKERS)
            path.write_text(f"---{frontmatter}---\n\n" + "\n".join(lines) + "\n")
            self.assert_invalid(repo, "bundled agent body is below the regression floor")

    def test_structured_but_truncated_worker_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            worker = "Writer"
            path = repo / f".copilot/agents/{worker}.agent.md"
            original = path.read_text()
            _, frontmatter, _ = original.split("---", 2)
            lines: list[str] = []
            for heading, markers in validator.BUNDLED_WORKER_REQUIRED_SECTION_MARKERS[worker].items():
                lines.append(heading)
                lines.extend(markers)
                lines.append("")
            path.write_text(f"---{frontmatter}---\n\n" + "\n".join(lines) + "\n")
            self.assert_invalid(repo, "bundled agent body is below the regression floor")

    def test_duplicate_required_orchestrator_section_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Orchestrator.agent.md"
            path.write_text(path.read_text() + "\n## Invariants\nDuplicate section.\n")
            self.assert_invalid(repo, "duplicate required Orchestrator section")

    def test_code_review_frontmatter_is_closed(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/skills/code-review/SKILL.md"
            path.write_text(path.read_text().replace("user-invocable: false\n", "user-invocable: false\nallowed-tools: read\n", 1))
            self.assert_invalid(repo, "code-review frontmatter contains unsupported keys")

    def test_all_bundled_workers_require_tool_boundary_enforcement_policy(self) -> None:
        policy = validator.BOUNDARY_ENFORCEMENT_POLICY
        for worker in validator.BUNDLED_WORKER_TOOLS:
            with self.subTest(worker=worker):
                temp, repo = self.make_repo()
                with temp:
                    path = repo / f".copilot/agents/{worker}.agent.md"
                    text = path.read_text()
                    self.assertIn(policy, text)
                    path.write_text(text.replace(policy, "REMOVED_TOOL_BOUNDARY_POLICY", 1))
                    self.assert_invalid(repo, "missing required bundled-worker policy")

    def test_writer_rejects_workspace_wide_problems_tool(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".copilot/agents/Writer.agent.md"
            path.write_text(path.read_text().replace("  - read/readFile\n", "  - read/readFile\n  - read/problems\n", 1))
            self.assert_invalid(repo, "bundled worker tools changed")


    def test_required_repository_files_cannot_be_removed(self) -> None:
        required_files = (
            ".gitignore",
            "LICENSE",
            "README.md",
            "README_ja.md",
            ".github/workflows/validate.yml",
            "scripts/validate_definitions.py",
            "tests/conformance.md",
            "tests/test_validate_definitions.py",
        )
        for relative_path in required_files:
            with self.subTest(path=relative_path):
                temp, repo = self.make_repo()
                with temp:
                    (repo / relative_path).unlink()
                    self.assert_invalid(repo, "missing required repository file")

    def test_validation_workflow_requires_validator_command(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(
                path.read_text().replace(
                    "run: python scripts/validate_definitions.py",
                    "run: echo validator skipped",
                    1,
                )
            )
            self.assert_invalid(repo, "missing required validation command")

    def test_validation_workflow_requires_mutation_test_command(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(
                path.read_text().replace(
                    'run: python -m unittest discover -s tests -p "test_*.py"',
                    "run: echo tests skipped",
                    1,
                )
            )
            self.assert_invalid(repo, "missing required validation command")

    def test_validation_workflow_requires_release_archive_build(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(
                path.read_text().replace(
                    "run: git archive --format=zip --output=dandori-release.zip HEAD",
                    "run: echo archive build skipped",
                    1,
                )
            )
            self.assert_invalid(repo, "missing required validation command")

    def test_validation_workflow_requires_release_archive_validation(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(
                path.read_text().replace(
                    "run: python scripts/validate_release_archive.py dandori-release.zip",
                    "run: echo archive validation skipped",
                    1,
                )
            )
            self.assert_invalid(repo, "missing required validation command")

    def test_validation_workflow_requires_pull_request_trigger(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(path.read_text().replace("  pull_request:\n", "", 1))
            self.assert_invalid(repo, "workflow must trigger on pull_request")

    def test_validation_workflow_requires_master_push_trigger(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(path.read_text().replace("      - master\n", "      - develop\n", 1))
            self.assert_invalid(repo, "push trigger must include branch 'master'")

    def test_validation_workflow_rejects_path_filters(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(
                path.read_text().replace(
                    "  pull_request:\n",
                    "  pull_request:\n    paths-ignore:\n      - 'docs/**'\n",
                    1,
                )
            )
            self.assert_invalid(repo, "pull_request trigger must not filter paths")

    def test_validate_job_cannot_be_conditionally_skipped(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(path.read_text().replace("  validate:\n", "  validate:\n    if: ${{ false }}\n", 1))
            self.assert_invalid(repo, "validate job must not define if")

    def test_validate_job_cannot_ignore_failures(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(
                path.read_text().replace(
                    "  validate:\n",
                    "  validate:\n    continue-on-error: true\n",
                    1,
                )
            )
            self.assert_invalid(repo, "validate job must not continue on error")

    def test_validate_job_cannot_depend_on_another_job(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(path.read_text().replace("  validate:\n", "  validate:\n    needs: setup\n", 1))
            self.assert_invalid(repo, "validate job must not depend on another job")

    def test_required_validation_commands_must_stay_in_validate_job(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            text = path.read_text()
            text = text.replace("run: python scripts/validate_definitions.py", "run: echo validator skipped", 1)
            text = text.replace(
                'run: python -m unittest discover -s tests -p "test_*.py"',
                "run: echo tests skipped",
                1,
            )
            text += """
  dead-validation:
    if: ${{ false }}
    runs-on: ubuntu-latest
    steps:
      - run: python scripts/validate_definitions.py
      - run: python -m unittest discover -s tests -p \"test_*.py\"
"""
            path.write_text(text)
            self.assert_invalid(repo, "missing required validation command in jobs.validate")

    def test_required_validation_step_cannot_be_conditionally_skipped(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(
                path.read_text().replace(
                    "      - name: Validate definitions\n        run: python scripts/validate_definitions.py",
                    "      - name: Validate definitions\n        if: ${{ false }}\n        run: python scripts/validate_definitions.py",
                    1,
                )
            )
            self.assert_invalid(repo, "required validation step must not define if")

    def test_required_validation_step_cannot_ignore_failures(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(
                path.read_text().replace(
                    "      - name: Validate definitions\n        run: python scripts/validate_definitions.py",
                    "      - name: Validate definitions\n        continue-on-error: true\n        run: python scripts/validate_definitions.py",
                    1,
                )
            )
            self.assert_invalid(repo, "required validation step must not continue on error")

    def test_required_validation_step_rejects_shell_override(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(
                path.read_text().replace(
                    "      - name: Validate definitions\n        run: python scripts/validate_definitions.py",
                    "      - name: Validate definitions\n        shell: bash {0} || true\n        run: python scripts/validate_definitions.py",
                    1,
                )
            )
            self.assert_invalid(repo, "required validation step must not override shell")

    def test_validate_workflow_rejects_extra_steps(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(
                path.read_text().replace(
                    "      - name: Validate definitions\n",
                    "      - name: Mutate validation inputs\n        run: echo tamper\n\n      - name: Validate definitions\n",
                    1,
                )
            )
            self.assert_invalid(repo, "validate job must contain exactly seven approved steps")

    def test_validate_workflow_rejects_global_run_defaults(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(
                path.read_text().replace(
                    "permissions:\n",
                    "defaults:\n  run:\n    shell: bash {0} || true\n\npermissions:\n",
                    1,
                )
            )
            self.assert_invalid(repo, "validation workflow must not define global defaults")

    def test_validate_job_requires_github_hosted_runner(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(path.read_text().replace("runs-on: ubuntu-latest", "runs-on: self-hosted", 1))
            self.assert_invalid(repo, "validate job must run on ubuntu-latest")

    def test_validation_workflow_requires_read_only_permissions(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(path.read_text().replace("  contents: read", "  contents: write", 1))
            self.assert_invalid(repo, "validation workflow permissions must be exactly contents: read")

    def test_checkout_step_cannot_override_repository(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(
                path.read_text().replace(
                    "        uses: actions/checkout@",
                    "        with:\n          repository: attacker/repository\n        uses: actions/checkout@",
                    1,
                )
            )
            self.assert_invalid(repo, "checkout step contains unsupported keys")

    def test_all_conformance_cases_are_required(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / "tests/conformance.md"
            text = path.read_text()
            start = text.index("### CONF-013")
            path.write_text(text[:start])
            self.assert_invalid(repo, "missing required conformance cases")

    def test_conformance_run_record_lists_every_case(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / "tests/conformance.md"
            path.write_text(
                path.read_text().replace(
                    "  CONF-013: pass|fail|blocked|not_run\n",
                    "",
                    1,
                )
            )
            self.assert_invalid(repo, "run-record template is missing cases")

    def test_new_conformance_case_requires_run_record_entry(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / "tests/conformance.md"
            path.write_text(
                path.read_text()
                + "\n\n### CONF-014 — Future case\n\n**Input**\n\nFuture input.\n\n**Expected**\n\n- Future result.\n"
            )
            self.assert_invalid(repo, "run-record template is missing cases")

    def test_conformance_run_record_requires_dandori_revision(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / "tests/conformance.md"
            path.write_text(path.read_text().replace('dandori_revision: ""\n', "", 1))
            self.assert_invalid(repo, "run-record template is missing dandori_revision")

    def test_conformance_input_cannot_be_empty(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / "tests/conformance.md"
            path.write_text(
                path.read_text().replace(
                    "Return two material Worker claims about the same active criterion that conflict on an objectively rerunnable test result. The approved permission includes a non-mutating test command.",
                    "",
                    1,
                )
            )
            self.assert_invalid(repo, "CONF-011 Input must not be empty")

    def test_conformance_expected_cannot_be_empty(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / "tests/conformance.md"
            text = path.read_text()
            start = text.index("**Expected**", text.index("### CONF-013")) + len("**Expected**")
            path.write_text(text[:start] + "\n")
            self.assert_invalid(repo, "CONF-013 Expected must not be empty")

    def test_required_mutation_test_methods_cannot_be_removed(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / "tests/test_validate_definitions.py"
            text = path.read_text()
            start = text.index("    def test_orchestrator_rejects_edit_tool")
            end = text.index("    def test_worker_rejects_agent_tool", start)
            path.write_text(text[:start] + text[end:])
            self.assert_invalid(repo, "missing required mutation tests")

    def test_required_mutation_test_bodies_cannot_be_empty(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / "tests/test_validate_definitions.py"
            text = path.read_text()
            start = text.index("    def test_orchestrator_rejects_edit_tool")
            end = text.index("    def test_worker_rejects_agent_tool", start)
            replacement = "    def test_orchestrator_rejects_edit_tool(self) -> None:\n        pass\n\n"
            path.write_text(text[:start] + replacement + text[end:])
            self.assert_invalid(repo, "required mutation test body is incomplete")

    def test_required_mutation_test_helpers_cannot_be_empty(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / "tests/test_validate_definitions.py"
            text = path.read_text()
            start = text.index("    def assert_invalid")
            end = text.index("    def test_repository_is_valid", start)
            replacement = "    def assert_invalid(self, repo: Path, needle: str) -> None:\n        pass\n\n"
            path.write_text(text[:start] + replacement + text[end:])
            self.assert_invalid(repo, "required mutation test helper is incomplete")

    @unittest.skipUnless(hasattr(os, "symlink"), "symlink support is required")
    def test_repository_symlinks_are_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            external = repo.parent / "external-writer.agent.md"
            external.write_text((repo / ".copilot/agents/Writer.agent.md").read_text())
            path = repo / ".copilot/agents/Writer.agent.md"
            path.unlink()
            path.symlink_to(external)
            self.assert_invalid(repo, "repository symlinks are forbidden")

    def test_python_ignore_rules_are_required(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".gitignore"
            path.write_text(path.read_text().replace("__pycache__/\n", "", 1))
            self.assert_invalid(repo, "missing required Python ignore patterns")

    def test_validate_workflow_disables_python_bytecode(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            path.write_text(path.read_text().replace('      PYTHONDONTWRITEBYTECODE: "1"\n', "", 1))
            self.assert_invalid(repo, "must set PYTHONDONTWRITEBYTECODE to 1")

    def test_tracked_python_generated_artifact_is_rejected(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
            generated = repo / "scripts/__pycache__/generated.pyc"
            generated.parent.mkdir(parents=True, exist_ok=True)
            generated.write_bytes(b"generated")
            subprocess.run(
                ["git", "-C", str(repo), "add", "-f", "scripts/__pycache__/generated.pyc"],
                check=True,
            )
            self.assert_invalid(repo, "tracked generated artifacts are forbidden")

    def test_docker_action_requires_digest(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/extra.yml"
            path.write_text(
                "name: Extra\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker://alpine:latest\n"
            )
            self.assert_invalid(repo, "Docker action must be pinned to a sha256 digest")

    def test_list_style_workflow_action_requires_full_commit_sha(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/extra.yml"
            path.write_text(
                "name: Extra\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/cache@v4\n"
            )
            self.assert_invalid(repo, "external action must be pinned to a full-length commit SHA")

    def test_inline_workflow_action_requires_full_commit_sha(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/extra.yml"
            path.write_text(
                "name: Extra\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - { name: Cache, uses: actions/cache@v4 }\n"
            )
            self.assert_invalid(repo, "external action must be pinned to a full-length commit SHA")

    def test_reusable_workflow_requires_full_commit_sha(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/extra.yml"
            path.write_text(
                "name: Extra\non: push\njobs:\n  reusable:\n    uses: owner/repository/.github/workflows/check.yml@main\n"
            )
            self.assert_invalid(repo, "external action must be pinned to a full-length commit SHA")

    def test_workflow_actions_require_full_commit_sha(self) -> None:
        temp, repo = self.make_repo()
        with temp:
            path = repo / ".github/workflows/validate.yml"
            text = path.read_text().replace(
                "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
                "actions/checkout@v7",
                1,
            )
            path.write_text(text)
            self.assert_invalid(repo, "external action must be pinned to a full-length commit SHA")

if __name__ == "__main__":
    unittest.main()
