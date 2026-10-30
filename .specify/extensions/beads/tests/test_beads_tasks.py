import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts" / "beads_tasks.py"
SPEC = importlib.util.spec_from_file_location("beads_tasks", SCRIPT)
beads_tasks = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = beads_tasks
SPEC.loader.exec_module(beads_tasks)

FIXTURES = ROOT / "tests" / "fixtures"
PROJECT = FIXTURES / "project"


def graph_payload():
    return json.loads((FIXTURES / "task-graph.json").read_text())


class GraphValidationTests(unittest.TestCase):
    def test_parses_artifacts_and_dependency_order(self):
        graph = beads_tasks.parse_graph(PROJECT, graph_payload())

        self.assertEqual(graph.feature_key, "001-example")
        self.assertEqual(
            [task.key for task in beads_tasks.topological_order(graph.tasks)],
            ["create-example-model", "implement-create-example"],
        )
        self.assertEqual(graph.tasks[1].dependencies, ("create-example-model",))

    def test_rejects_dependency_cycle(self):
        payload = graph_payload()
        payload["tasks"][0]["dependencies"] = ["implement-create-example"]

        with self.assertRaisesRegex(beads_tasks.TaskGraphError, "dependency cycle"):
            beads_tasks.parse_graph(PROJECT, payload)

    def test_rejects_undeclared_source_reference(self):
        payload = graph_payload()
        payload["tasks"][0]["source_refs"] = ["specs/001-example/unknown.md"]

        with self.assertRaisesRegex(beads_tasks.TaskGraphError, "does not resolve"):
            beads_tasks.parse_graph(PROJECT, payload)

    def test_rejects_duplicate_display_id(self):
        payload = graph_payload()
        payload["tasks"][1]["display_id"] = "T001"

        with self.assertRaisesRegex(beads_tasks.TaskGraphError, "duplicate display ID"):
            beads_tasks.parse_graph(PROJECT, payload)

    def test_requires_present_research_artifact(self):
        payload = graph_payload()
        payload["artifacts"].pop("research")

        with self.assertRaisesRegex(beads_tasks.TaskGraphError, "artifacts.research is required"):
            beads_tasks.parse_graph(PROJECT, payload)

    def test_requires_every_contract_file(self):
        payload = graph_payload()
        payload["artifacts"]["contracts"] = []

        with self.assertRaisesRegex(beads_tasks.TaskGraphError, "must list every contract file"):
            beads_tasks.parse_graph(PROJECT, payload)


class ReconciliationTests(unittest.TestCase):
    def test_managed_labels_are_replaced_and_human_labels_preserved(self):
        labels = beads_tasks.merge_labels(
            ["owner:payments", "speckit:old", "parallel"],
            ["speckit", "speckit:001-example"],
        )

        self.assertEqual(labels, ["owner:payments", "speckit", "speckit:001-example"])

    def test_status_does_not_trigger_update(self):
        graph = beads_tasks.parse_graph(PROJECT, graph_payload())
        desired = beads_tasks.desired_task(PROJECT, graph, graph.tasks[0])
        issue = {**copy.deepcopy(desired), "status": "closed"}

        self.assertFalse(beads_tasks.issue_needs_update(issue, desired))

    def test_epic_stores_spec_design_digests_and_planned_dag(self):
        graph = beads_tasks.parse_graph(PROJECT, graph_payload())

        epic = beads_tasks.desired_epic(PROJECT, graph)

        self.assertIn("FR-001", epic["description"])
        self.assertIn("Implementation Plan", epic["design"])
        self.assertIn("Use the standard library", epic["design"])
        self.assertEqual(
            epic["acceptance_criteria"],
            "A valid request creates an example that satisfies FR-001.",
        )
        speckit = epic["metadata"]["speckit"]
        self.assertIn("specs/001-example/spec.md", speckit["artifact_digests"])
        self.assertEqual(
            speckit["planned_dag"]["dependencies"]["implement-create-example"],
            ["create-example-model"],
        )

    def test_task_stores_relevant_source_context(self):
        graph = beads_tasks.parse_graph(PROJECT, graph_payload())

        task = beads_tasks.desired_task(PROJECT, graph, graph.tasks[0])

        self.assertIn("An example has an identifier and name", task["design"])
        self.assertIn("Create the model before the service", task["design"])
        self.assertIn("Depends on task keys: none", task["notes"])


class FakeBeads:
    def __init__(self, issues, dependencies):
        self._issues = issues
        self._dependencies = dependencies
        self.project_root = PROJECT

    def list_all(self):
        return self._issues

    def dependencies(self, issue_id):
        return self._dependencies.get(issue_id, [])

    def show(self, issue_id):
        return next(issue for issue in self._issues if issue["id"] == issue_id)


class StableIdentityTests(unittest.TestCase):
    def test_reconciliation_rejects_display_id_churn(self):
        graph = beads_tasks.parse_graph(PROJECT, graph_payload())
        epic = {
            **beads_tasks.desired_epic(PROJECT, graph),
            "id": "bd-epic",
            "external_ref": "speckit:001-example",
            "issue_type": "epic",
        }
        task = {
            **beads_tasks.desired_task(PROJECT, graph, graph.tasks[0]),
            "id": "bd-task",
            "external_ref": "speckit:001-example:create-example-model",
            "issue_type": "task",
            "parent": "bd-epic",
        }
        task["metadata"]["speckit"]["display_id"] = "T099"

        with self.assertRaisesRegex(beads_tasks.TaskGraphError, "preserve existing display ID"):
            beads_tasks.build_reconciliation(graph, FakeBeads([epic, task], {}))


class RenderTests(unittest.TestCase):
    def test_renders_beads_status_and_dependencies(self):
        epic = {
            "id": "bd-epic",
            "title": "Spec Kit: Example Feature",
            "external_ref": "speckit:001-example",
            "issue_type": "epic",
            "metadata": {"speckit": {"feature_dir": "specs/001-example"}},
        }
        first = {
            "id": "bd-1",
            "title": "T001: Create model",
            "external_ref": "speckit:001-example:create-example-model",
            "issue_type": "task",
            "status": "closed",
            "metadata": {
                "speckit": {
                    "display_id": "T001",
                    "phase": "Foundational",
                    "story": None,
                    "parallel": False,
                }
            },
        }
        second = {
            "id": "bd-2",
            "title": "T002: Implement creation",
            "external_ref": "speckit:001-example:implement-create-example",
            "issue_type": "task",
            "status": "open",
            "metadata": {
                "speckit": {
                    "display_id": "T002",
                    "phase": "User Story 1",
                    "story": "US1",
                    "parallel": True,
                }
            },
        }
        fake = FakeBeads(
            [epic, first, second],
            {"bd-2": [{"external_ref": first["external_ref"]}]},
        )

        markdown, _ = beads_tasks.render_markdown(fake, "001-example")

        self.assertIn("- [x] T001 Create model", markdown)
        self.assertIn("- [ ] T002 [P] [US1] Implement creation", markdown)
        self.assertIn("`T002` depends on `T001`", markdown)


class DagStatusTests(unittest.TestCase):
    def test_projects_current_and_future_execution_waves(self):
        epic = {
            "id": "bd-epic",
            "title": "Spec Kit: Example Feature",
            "external_ref": "speckit:001-example",
            "issue_type": "epic",
            "status": "open",
            "metadata": {"speckit": {"feature_dir": "specs/001-example"}},
        }

        def task(number, key, status):
            return {
                "id": f"bd-{number}",
                "title": f"T00{number}: Task {number}",
                "external_ref": f"speckit:001-example:{key}",
                "issue_type": "task",
                "status": status,
                "priority": 1,
                "metadata": {
                    "speckit": {
                        "display_id": f"T00{number}",
                        "task_key": key,
                    }
                },
            }

        first = task(1, "first", "closed")
        second = task(2, "second", "open")
        third = task(3, "third", "open")
        fake = FakeBeads(
            [epic, first, second, third],
            {
                "bd-2": [{**first, "dependency_type": "blocks"}],
                "bd-3": [{**second, "dependency_type": "blocks"}],
            },
        )

        status = beads_tasks.dag_status(fake, "001-example")

        self.assertEqual([task["task_key"] for task in status["current"]], ["second"])
        self.assertEqual(
            [[task["task_key"] for task in wave["tasks"]] for wave in status["waves"]],
            [["second"], ["third"]],
        )
        self.assertEqual(status["counts"]["closed"], 1)
        self.assertEqual(status["counts"]["blocked"], 0)


if __name__ == "__main__":
    unittest.main()
