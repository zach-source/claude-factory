#!/usr/bin/env python3
"""Use Beads as the task-planning and execution backend for Spec Kit."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


KEY_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
DISPLAY_ID_RE = re.compile(r"^T\d{3,}$")
MANAGED_LABEL_PREFIXES = ("speckit:", "story:", "phase:", "task:")
MANAGED_LABELS = {"speckit", "parallel"}


class TaskGraphError(RuntimeError):
    """A user-actionable graph or reconciliation error."""


@dataclass(frozen=True)
class TaskSpec:
    key: str
    display_id: str
    title: str
    description: str
    acceptance_criteria: str
    phase: str
    story: str | None
    parallel: bool
    priority: int
    dependencies: tuple[str, ...]
    source_refs: tuple[str, ...]


@dataclass(frozen=True)
class TaskGraph:
    feature_key: str
    feature_title: str
    feature_summary: str
    feature_acceptance_criteria: str
    feature_dir: str
    feature_priority: int
    artifacts: dict[str, Any]
    tasks: tuple[TaskSpec, ...]


def require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TaskGraphError(f"{field} must be a non-empty string")
    return value.strip()


def require_priority(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 4:
        raise TaskGraphError(f"{field} must be an integer from 0 to 4")
    return value


def require_string_list(value: Any, field: str, *, allow_empty: bool = True) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise TaskGraphError(f"{field} must be an array of strings")
    items = tuple(item.strip() for item in value if item.strip())
    if not allow_empty and not items:
        raise TaskGraphError(f"{field} must contain at least one item")
    if len(items) != len(set(items)):
        raise TaskGraphError(f"{field} contains duplicates")
    return items


def has_symlink_component(project_root: Path, path: Path) -> bool:
    root = project_root.resolve()
    try:
        relative = path.absolute().relative_to(root)
    except ValueError:
        return True
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            return True
    return False


def safe_existing_path(project_root: Path, ref: str, field: str) -> Path:
    path_text = ref.split("#", 1)[0]
    relative = Path(path_text)
    if relative.is_absolute() or ".." in relative.parts:
        raise TaskGraphError(f"{field} must be a project-relative path: {ref}")
    candidate = project_root / relative
    if has_symlink_component(project_root, candidate):
        raise TaskGraphError(f"{field} traverses a symlink or leaves the project: {ref}")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(project_root.resolve())
    except (FileNotFoundError, ValueError) as exc:
        raise TaskGraphError(f"{field} does not resolve inside the project: {ref}") from exc
    return resolved


def normalize_artifacts(project_root: Path, feature_dir: str, raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise TaskGraphError("artifacts must be an object")
    feature_root = safe_existing_path(project_root, feature_dir, "feature.directory")
    if not feature_root.is_dir():
        raise TaskGraphError("feature.directory must reference a directory")
    normalized: dict[str, Any] = {}
    for required in ("spec", "plan"):
        ref = require_string(raw.get(required), f"artifacts.{required}")
        safe_existing_path(project_root, ref, f"artifacts.{required}")
        normalized[required] = ref

    for optional in ("research", "data_model", "quickstart", "constitution"):
        value = raw.get(optional)
        if value is None:
            continue
        ref = require_string(value, f"artifacts.{optional}")
        safe_existing_path(project_root, ref, f"artifacts.{optional}")
        normalized[optional] = ref

    expected_optional = {
        "research": feature_root / "research.md",
        "data_model": feature_root / "data-model.md",
        "quickstart": feature_root / "quickstart.md",
        "constitution": project_root / ".specify/memory/constitution.md",
    }
    for name, expected in expected_optional.items():
        if expected.is_file() and name not in normalized:
            relative = expected.relative_to(project_root).as_posix()
            raise TaskGraphError(f"artifacts.{name} is required because {relative} exists")
        if name in normalized:
            if not expected.is_file() or safe_existing_path(
                project_root, normalized[name], f"artifacts.{name}"
            ) != expected.resolve(strict=True):
                raise TaskGraphError(f"artifacts.{name} must reference {expected}")

    contracts = require_string_list(raw.get("contracts", []), "artifacts.contracts")
    for index, ref in enumerate(contracts):
        path = safe_existing_path(project_root, ref, f"artifacts.contracts[{index}]")
        if not path.is_file():
            raise TaskGraphError(f"artifacts.contracts[{index}] must reference a file")
    normalized["contracts"] = list(contracts)
    contracts_dir = feature_root / "contracts"
    contract_entries = list(contracts_dir.rglob("*")) if contracts_dir.is_dir() else []
    if any(path.is_symlink() for path in contract_entries):
        raise TaskGraphError("contracts directory must not contain symlinks")
    expected_contracts = {
        path.relative_to(project_root).as_posix()
        for path in contract_entries
        if path.is_file()
    } if contracts_dir.is_dir() else set()
    if set(contracts) != expected_contracts:
        missing = sorted(expected_contracts - set(contracts))
        extra = sorted(set(contracts) - expected_contracts)
        details = []
        if missing:
            details.append(f"missing: {', '.join(missing)}")
        if extra:
            details.append(f"unexpected: {', '.join(extra)}")
        raise TaskGraphError(f"artifacts.contracts must list every contract file ({'; '.join(details)})")
    for name in ("spec", "plan", "research", "data_model", "quickstart"):
        ref = normalized.get(name)
        if ref and feature_root not in safe_existing_path(project_root, ref, f"artifacts.{name}").parents:
            raise TaskGraphError(f"artifacts.{name} must be inside feature.directory")
    expected_required = {"spec": feature_root / "spec.md", "plan": feature_root / "plan.md"}
    for name, expected in expected_required.items():
        if safe_existing_path(project_root, normalized[name], f"artifacts.{name}") != expected.resolve(strict=True):
            raise TaskGraphError(f"artifacts.{name} must reference {expected}")
    for index, ref in enumerate(contracts):
        if feature_root not in safe_existing_path(project_root, ref, f"artifacts.contracts[{index}]").parents:
            raise TaskGraphError(f"artifacts.contracts[{index}] must be inside feature.directory")
    return normalized


def parse_graph(project_root: Path, payload: Any) -> TaskGraph:
    if not isinstance(payload, dict):
        raise TaskGraphError("task graph must be a JSON object")
    feature = payload.get("feature")
    if not isinstance(feature, dict):
        raise TaskGraphError("feature must be an object")

    feature_key = require_string(feature.get("key"), "feature.key")
    if not KEY_RE.fullmatch(feature_key):
        raise TaskGraphError("feature.key must be lowercase kebab-case")
    feature_dir = require_string(feature.get("directory"), "feature.directory")
    if Path(feature_dir).name != feature_key:
        raise TaskGraphError("feature.key must match the feature.directory basename")
    artifacts = normalize_artifacts(project_root, feature_dir, payload.get("artifacts"))

    raw_tasks = payload.get("tasks")
    if not isinstance(raw_tasks, list) or not raw_tasks:
        raise TaskGraphError("tasks must be a non-empty array")

    tasks: list[TaskSpec] = []
    keys: set[str] = set()
    display_ids: set[str] = set()
    allowed_source_paths = {
        value
        for name, value in artifacts.items()
        if name != "contracts" and isinstance(value, str)
    }
    allowed_source_paths.update(artifacts.get("contracts", []))

    for index, raw_task in enumerate(raw_tasks):
        field = f"tasks[{index}]"
        if not isinstance(raw_task, dict):
            raise TaskGraphError(f"{field} must be an object")
        key = require_string(raw_task.get("key"), f"{field}.key")
        if not KEY_RE.fullmatch(key):
            raise TaskGraphError(f"{field}.key must be lowercase kebab-case")
        if key in keys:
            raise TaskGraphError(f"duplicate task key: {key}")
        keys.add(key)

        display_id = require_string(raw_task.get("display_id"), f"{field}.display_id").upper()
        if not DISPLAY_ID_RE.fullmatch(display_id):
            raise TaskGraphError(f"{field}.display_id must match T followed by at least three digits")
        if display_id in display_ids:
            raise TaskGraphError(f"duplicate display ID: {display_id}")
        display_ids.add(display_id)

        story_value = raw_task.get("story")
        story = None if story_value is None else require_string(story_value, f"{field}.story")
        parallel = raw_task.get("parallel", False)
        if not isinstance(parallel, bool):
            raise TaskGraphError(f"{field}.parallel must be a boolean")
        dependencies = require_string_list(raw_task.get("dependencies", []), f"{field}.dependencies")
        source_refs = require_string_list(
            raw_task.get("source_refs"), f"{field}.source_refs", allow_empty=False
        )
        for source_index, ref in enumerate(source_refs):
            safe_existing_path(project_root, ref, f"{field}.source_refs[{source_index}]")
            path_part = ref.split("#", 1)[0]
            if path_part not in allowed_source_paths:
                raise TaskGraphError(
                    f"{field}.source_refs[{source_index}] is not declared in artifacts: {ref}"
                )

        tasks.append(
            TaskSpec(
                key=key,
                display_id=display_id,
                title=require_string(raw_task.get("title"), f"{field}.title"),
                description=require_string(raw_task.get("description"), f"{field}.description"),
                acceptance_criteria=require_string(
                    raw_task.get("acceptance_criteria"), f"{field}.acceptance_criteria"
                ),
                phase=require_string(raw_task.get("phase"), f"{field}.phase"),
                story=story,
                parallel=parallel,
                priority=require_priority(raw_task.get("priority", 2), f"{field}.priority"),
                dependencies=dependencies,
                source_refs=source_refs,
            )
        )

    for task in tasks:
        missing = sorted(set(task.dependencies) - keys)
        if missing:
            raise TaskGraphError(
                f"task {task.key} depends on unknown task(s): {', '.join(missing)}"
            )
        if task.key in task.dependencies:
            raise TaskGraphError(f"task {task.key} cannot depend on itself")
    topological_order(tasks)

    return TaskGraph(
        feature_key=feature_key,
        feature_title=require_string(feature.get("title"), "feature.title"),
        feature_summary=require_string(feature.get("summary"), "feature.summary"),
        feature_acceptance_criteria=require_string(
            feature.get("acceptance_criteria"), "feature.acceptance_criteria"
        ),
        feature_dir=feature_dir,
        feature_priority=require_priority(feature.get("priority", 1), "feature.priority"),
        artifacts=artifacts,
        tasks=tuple(tasks),
    )


def topological_order(tasks: Iterable[TaskSpec]) -> list[TaskSpec]:
    ordered_input = list(tasks)
    by_key = {task.key: task for task in ordered_input}
    indegree = {task.key: len(task.dependencies) for task in ordered_input}
    dependents: dict[str, list[str]] = {task.key: [] for task in ordered_input}
    for task in ordered_input:
        for dependency in task.dependencies:
            dependents[dependency].append(task.key)

    ready = [task.key for task in ordered_input if indegree[task.key] == 0]
    result: list[TaskSpec] = []
    while ready:
        key = ready.pop(0)
        result.append(by_key[key])
        for dependent in dependents[key]:
            indegree[dependent] -= 1
            if indegree[dependent] == 0:
                ready.append(dependent)
    if len(result) != len(ordered_input):
        cyclic = sorted(key for key, degree in indegree.items() if degree > 0)
        raise TaskGraphError(f"task graph contains a dependency cycle involving: {', '.join(cyclic)}")
    return result


class Beads:
    def __init__(self, project_root: Path):
        executable = shutil.which("bd")
        if not executable:
            raise TaskGraphError("Beads CLI 'bd' is not installed or not on PATH")
        self.executable = executable
        self.project_root = project_root
        self.env = os.environ.copy()
        try:
            metadata = json.loads((project_root / ".beads/metadata.json").read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            metadata = {}
        if isinstance(metadata, dict) and metadata.get("dolt_mode") == "embedded":
            for key in (
                "BEADS_DOLT_SHARED_SERVER",
                "BEADS_DOLT_SERVER_HOST",
                "BEADS_DOLT_SERVER_PORT",
            ):
                self.env.pop(key, None)

    def run(self, *args: str, json_output: bool = False) -> Any:
        command = [self.executable, *args]
        result = subprocess.run(
            command,
            cwd=self.project_root,
            env=self.env,
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            raise TaskGraphError(f"{' '.join(command)} failed: {detail}")
        if json_output:
            try:
                return json.loads(result.stdout)
            except json.JSONDecodeError as exc:
                raise TaskGraphError(f"{' '.join(command)} returned invalid JSON") from exc
        return result.stdout.strip()

    def list_all(self) -> list[dict[str, Any]]:
        payload = self.run("list", "--all", "--limit", "0", "--json", json_output=True)
        if not isinstance(payload, list):
            raise TaskGraphError("bd list returned an unexpected JSON shape")
        return payload

    def dependencies(self, issue_id: str) -> list[dict[str, Any]]:
        payload = self.run(
            "dep", "list", issue_id, "--type", "blocks", "--json", json_output=True
        )
        if not isinstance(payload, list):
            raise TaskGraphError("bd dep list returned an unexpected JSON shape")
        return payload

    def show(self, issue_id: str) -> dict[str, Any]:
        payload = self.run("show", issue_id, "--json", json_output=True)
        if isinstance(payload, list) and len(payload) == 1 and isinstance(payload[0], dict):
            return payload[0]
        if isinstance(payload, dict):
            return payload
        raise TaskGraphError("bd show returned an unexpected JSON shape")

    def create(self, *args: str) -> str:
        issue_id = self.run("create", *args, "--silent").strip()
        if not issue_id:
            raise TaskGraphError("bd create did not return an issue ID")
        return issue_id


def slug(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return normalized or "phase"


def issue_metadata(issue: dict[str, Any]) -> dict[str, Any]:
    metadata = issue.get("metadata")
    if isinstance(metadata, dict):
        return metadata
    if isinstance(metadata, str):
        try:
            parsed = json.loads(metadata)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def is_managed_label(label: str) -> bool:
    return label in MANAGED_LABELS or label.startswith(MANAGED_LABEL_PREFIXES)


def merge_labels(existing: Iterable[str], managed: Iterable[str]) -> list[str]:
    human = {label for label in existing if not is_managed_label(label)}
    return sorted(human | set(managed))


def task_labels(graph: TaskGraph, task: TaskSpec) -> list[str]:
    labels = {
        "speckit",
        f"speckit:{graph.feature_key}",
        f"task:{task.display_id.lower()}",
        f"phase:{slug(task.phase)}",
    }
    if task.story:
        labels.add(f"story:{slug(task.story)}")
    if task.parallel:
        labels.add("parallel")
    return sorted(labels)


def read_artifact(project_root: Path, ref: str) -> str:
    path = safe_existing_path(project_root, ref, "artifact reference")
    if not path.is_file():
        raise TaskGraphError(f"artifact reference must be a file: {ref}")
    return path.read_bytes().decode("utf-8", errors="replace")


def artifact_refs(graph: TaskGraph) -> list[str]:
    refs: list[str] = []
    for name in ("spec", "plan", "research", "data_model", "quickstart", "constitution"):
        value = graph.artifacts.get(name)
        if isinstance(value, str):
            refs.append(value)
    refs.extend(graph.artifacts.get("contracts", []))
    return refs


def artifact_digests(project_root: Path, graph: TaskGraph) -> dict[str, str]:
    return {
        ref: f"sha256:{hashlib.sha256(safe_existing_path(project_root, ref, 'artifact reference').read_bytes()).hexdigest()}"
        for ref in artifact_refs(graph)
    }


def artifact_snapshot(project_root: Path, ref: str, heading: str) -> str:
    return f"## {heading}\n\nSource: `{ref}`\n\n{read_artifact(project_root, ref).rstrip()}"


def epic_description(project_root: Path, graph: TaskGraph) -> str:
    return (
        f"{graph.feature_summary}\n\n"
        f"---\n\n"
        f"# Stored Spec Kit specification\n\n"
        f"Source: `{graph.artifacts['spec']}`\n\n"
        f"{read_artifact(project_root, graph.artifacts['spec']).rstrip()}"
    )


def epic_design(project_root: Path, graph: TaskGraph) -> str:
    sections = [artifact_snapshot(project_root, graph.artifacts["plan"], "Implementation plan")]
    labels = {
        "research": "Research and decisions",
        "data_model": "Data model",
        "quickstart": "Quickstart and validation",
        "constitution": "Project constitution",
    }
    for name, heading in labels.items():
        ref = graph.artifacts.get(name)
        if isinstance(ref, str):
            sections.append(artifact_snapshot(project_root, ref, heading))
    for ref in graph.artifacts.get("contracts", []):
        sections.append(artifact_snapshot(project_root, ref, f"Contract: {Path(ref).name}"))
    return "\n\n---\n\n".join(sections)


def extract_fragment(text: str, fragment: str) -> str:
    lines = text.splitlines()
    normalized = fragment.lower().replace("-", " ").strip()
    for index, line in enumerate(lines):
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if not heading:
            continue
        title = heading.group(2).lower().replace("-", " ").strip()
        if normalized not in title and title not in normalized:
            continue
        level = len(heading.group(1))
        end = len(lines)
        for following in range(index + 1, len(lines)):
            next_heading = re.match(r"^(#{1,6})\s+", lines[following])
            if next_heading and len(next_heading.group(1)) <= level:
                end = following
                break
        return "\n".join(lines[index:end]).strip()
    for index, line in enumerate(lines):
        if fragment.lower() in line.lower():
            return "\n".join(lines[max(0, index - 2) : min(len(lines), index + 4)]).strip()
    return text.strip()


def source_excerpt(project_root: Path, ref: str) -> str:
    path_ref, separator, fragment = ref.partition("#")
    text = read_artifact(project_root, path_ref)
    content = extract_fragment(text, fragment) if separator and fragment else text.strip()
    return f"## `{ref}`\n\n{content}"


def task_design(project_root: Path, task: TaskSpec) -> str:
    return "# Stored implementation context\n\n" + "\n\n---\n\n".join(
        source_excerpt(project_root, ref) for ref in task.source_refs
    )


def task_notes(task: TaskSpec) -> str:
    dependencies = ", ".join(task.dependencies) if task.dependencies else "none"
    sources = "\n".join(f"- {ref}" for ref in task.source_refs)
    return (
        f"Spec Kit display ID: {task.display_id}\n"
        f"Phase: {task.phase}\n"
        f"Story: {task.story or 'none'}\n"
        f"Parallel-safe: {'yes' if task.parallel else 'no'}\n"
        f"Depends on task keys: {dependencies}\n\n"
        f"Source references:\n{sources}"
    )


def desired_epic(
    project_root: Path,
    graph: TaskGraph,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    existing = existing or {}
    metadata = issue_metadata(existing)
    metadata["speckit"] = {
        "kind": "feature",
        "feature": graph.feature_key,
        "feature_dir": graph.feature_dir,
        "artifacts": graph.artifacts,
        "artifact_digests": artifact_digests(project_root, graph),
        "planned_dag": {
            "dependencies": {task.key: list(task.dependencies) for task in graph.tasks},
            "topological_order": [task.key for task in topological_order(graph.tasks)],
        },
    }
    return {
        "title": f"Spec Kit: {graph.feature_title}",
        "description": epic_description(project_root, graph),
        "design": epic_design(project_root, graph),
        "acceptance_criteria": graph.feature_acceptance_criteria,
        "notes": (
            f"Stored from {len(artifact_refs(graph))} Spec Kit artifacts. "
            f"Execution DAG contains {len(graph.tasks)} tasks and "
            f"{sum(len(task.dependencies) for task in graph.tasks)} dependency edges."
        ),
        "priority": graph.feature_priority,
        "spec_id": graph.artifacts["spec"],
        "labels": merge_labels(existing.get("labels", []), ["speckit", f"speckit:{graph.feature_key}"]),
        "metadata": metadata,
    }


def desired_task(
    project_root: Path,
    graph: TaskGraph,
    task: TaskSpec,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    existing = existing or {}
    metadata = issue_metadata(existing)
    metadata["speckit"] = {
        "kind": "task",
        "feature": graph.feature_key,
        "task_key": task.key,
        "display_id": task.display_id,
        "phase": task.phase,
        "story": task.story,
        "parallel": task.parallel,
        "dependency_keys": list(task.dependencies),
        "source_refs": list(task.source_refs),
    }
    return {
        "title": f"{task.display_id}: {task.title}",
        "description": task.description,
        "design": task_design(project_root, task),
        "acceptance_criteria": task.acceptance_criteria,
        "notes": task_notes(task),
        "priority": task.priority,
        "spec_id": task.source_refs[0],
        "labels": merge_labels(existing.get("labels", []), task_labels(graph, task)),
        "metadata": metadata,
    }


def issue_needs_update(issue: dict[str, Any], desired: dict[str, Any]) -> bool:
    for field in (
        "title",
        "description",
        "design",
        "acceptance_criteria",
        "notes",
        "priority",
        "spec_id",
    ):
        if issue.get(field) != desired[field]:
            return True
    if sorted(issue.get("labels", [])) != desired["labels"]:
        return True
    return issue_metadata(issue) != desired["metadata"]


def update_issue(
    beads: Beads,
    issue_id: str,
    desired: dict[str, Any],
    issue_type: str,
    parent: str | None = None,
) -> None:
    args = [
        "update",
        issue_id,
        "--title",
        desired["title"],
        "--description",
        desired["description"],
        "--design",
        desired["design"],
        "--acceptance",
        desired["acceptance_criteria"],
        "--notes",
        desired["notes"],
        "--priority",
        str(desired["priority"]),
        "--type",
        issue_type,
        "--spec-id",
        desired["spec_id"],
        "--set-labels",
        ",".join(desired["labels"]),
        "--metadata",
        json.dumps(desired["metadata"], separators=(",", ":")),
    ]
    if parent:
        args.extend(["--parent", parent])
    beads.run(*args)


def create_issue(
    beads: Beads,
    desired: dict[str, Any],
    external_ref: str,
    issue_type: str,
    parent: str | None = None,
) -> str:
    args = [
        desired["title"],
        "--type",
        issue_type,
        "--priority",
        str(desired["priority"]),
        "--description",
        desired["description"],
        "--design",
        desired["design"],
        "--acceptance",
        desired["acceptance_criteria"],
        "--notes",
        desired["notes"],
        "--external-ref",
        external_ref,
        "--spec-id",
        desired["spec_id"],
        "--labels",
        ",".join(desired["labels"]),
        "--metadata",
        json.dumps(desired["metadata"], separators=(",", ":")),
    ]
    if parent:
        args.extend(["--parent", parent])
    return beads.create(*args)


def dependency_ref(issue: dict[str, Any]) -> str | None:
    value = issue.get("external_ref")
    return value if isinstance(value, str) else None


def build_reconciliation(graph: TaskGraph, beads: Beads) -> tuple[dict[str, Any], dict[str, Any]]:
    all_issues = beads.list_all()
    epic_ref = f"speckit:{graph.feature_key}"
    managed = [
        issue
        for issue in all_issues
        if isinstance(issue.get("external_ref"), str)
        and (
            issue["external_ref"] == epic_ref
            or issue["external_ref"].startswith(f"{epic_ref}:")
        )
    ]
    by_ref = {
        issue["external_ref"]: beads.show(issue["id"])
        for issue in managed
    }
    epic = by_ref.get(epic_ref)
    epic_action = "create" if not epic else (
        "update"
        if issue_needs_update(epic, desired_epic(beads.project_root, graph, epic))
        else "existing"
    )

    create: list[str] = []
    update: list[str] = []
    existing: list[str] = []
    dependency_add: list[list[str]] = []
    dependency_remove: list[list[str]] = []
    task_refs = {task.key: f"{epic_ref}:{task.key}" for task in graph.tasks}
    existing_display_owners: dict[str, str] = {}
    for ref, issue in by_ref.items():
        if not ref.startswith(f"{epic_ref}:"):
            continue
        speckit = issue_metadata(issue).get("speckit", {})
        display_id = speckit.get("display_id") or speckit.get("task_id")
        if isinstance(display_id, str):
            existing_display_owners[display_id.upper()] = ref

    for task in graph.tasks:
        issue = by_ref.get(task_refs[task.key])
        owner = existing_display_owners.get(task.display_id)
        if owner and owner != task_refs[task.key]:
            raise TaskGraphError(
                f"display ID {task.display_id} already belongs to existing task {owner}"
            )
        if issue:
            speckit = issue_metadata(issue).get("speckit", {})
            existing_display_id = speckit.get("display_id") or speckit.get("task_id")
            if existing_display_id and str(existing_display_id).upper() != task.display_id:
                raise TaskGraphError(
                    f"task {task.key} must preserve existing display ID {existing_display_id}"
                )
        if not issue:
            create.append(task.key)
        elif issue_needs_update(issue, desired_task(beads.project_root, graph, task, issue)) or (
            epic and issue.get("parent") != epic.get("id")
        ):
            update.append(task.key)
        else:
            existing.append(task.key)

        current_refs: set[str] = set()
        if issue:
            current_refs = {
                ref
                for dependency in beads.dependencies(issue["id"])
                if (ref := dependency_ref(dependency))
                and ref.startswith(f"{epic_ref}:")
            }
        desired_refs = {task_refs[key] for key in task.dependencies}
        dependency_add.extend(
            [task.key, ref.rsplit(":", 1)[-1]] for ref in sorted(desired_refs - current_refs)
        )
        dependency_remove.extend(
            [task.key, ref.rsplit(":", 1)[-1]] for ref in sorted(current_refs - desired_refs)
        )

    desired_refs = set(task_refs.values())
    stale = sorted(
        ref[len(epic_ref) + 1 :]
        for ref in by_ref
        if ref.startswith(f"{epic_ref}:") and ref not in desired_refs
    )
    preview = {
        "mode": "preview",
        "feature": graph.feature_key,
        "epic": epic_action,
        "create": create,
        "update": update,
        "existing": existing,
        "stale": stale,
        "dependency_add": dependency_add,
        "dependency_remove": dependency_remove,
        "execution_order": [task.key for task in topological_order(graph.tasks)],
    }
    state = {"by_ref": by_ref, "epic_ref": epic_ref, "task_refs": task_refs}
    return preview, state


def apply_reconciliation(
    graph: TaskGraph,
    beads: Beads,
    preview: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    by_ref: dict[str, dict[str, Any]] = state["by_ref"]
    epic_ref: str = state["epic_ref"]
    task_refs: dict[str, str] = state["task_refs"]

    epic = by_ref.get(epic_ref)
    desired = desired_epic(beads.project_root, graph, epic)
    if not epic:
        epic_id = create_issue(beads, desired, epic_ref, "epic")
        epic = {"id": epic_id, "external_ref": epic_ref}
        by_ref[epic_ref] = epic
    else:
        epic_id = epic["id"]
        if preview["epic"] == "update":
            update_issue(beads, epic_id, desired, "epic")

    ids_by_key: dict[str, str] = {}
    by_key = {task.key: task for task in graph.tasks}
    for task in graph.tasks:
        ref = task_refs[task.key]
        issue = by_ref.get(ref)
        desired = desired_task(beads.project_root, graph, task, issue)
        if not issue:
            issue_id = create_issue(beads, desired, ref, "task", epic_id)
            issue = {"id": issue_id, "external_ref": ref}
            by_ref[ref] = issue
        else:
            issue_id = issue["id"]
            if task.key in preview["update"]:
                update_issue(beads, issue_id, desired, "task", epic_id)
        ids_by_key[task.key] = issue_id

    for task_key, dependency_key in preview["dependency_remove"]:
        dependency = by_ref.get(f"{epic_ref}:{dependency_key}")
        if not dependency:
            raise TaskGraphError(
                f"cannot remove dependency on missing managed task: {dependency_key}"
            )
        beads.run("dep", "remove", ids_by_key[task_key], dependency["id"])
    for task_key, dependency_key in preview["dependency_add"]:
        beads.run("dep", "add", ids_by_key[task_key], ids_by_key[dependency_key])

    return {
        **preview,
        "mode": "apply",
        "epic_id": epic_id,
        "task_ids": {key: ids_by_key[key] for key in by_key},
    }


def reconcile(project_root: Path, graph_path: Path, apply: bool) -> dict[str, Any]:
    try:
        payload = json.loads(graph_path.read_text())
    except FileNotFoundError as exc:
        raise TaskGraphError(f"graph file not found: {graph_path}") from exc
    except json.JSONDecodeError as exc:
        raise TaskGraphError(f"graph file is invalid JSON: {exc}") from exc
    graph = parse_graph(project_root, payload)
    beads = Beads(project_root)
    preview, state = build_reconciliation(graph, beads)
    return apply_reconciliation(graph, beads, preview, state) if apply else preview


def display_id_number(issue: dict[str, Any]) -> int:
    value = issue_metadata(issue).get("speckit", {}).get("display_id", "T999999999")
    match = re.search(r"\d+", str(value))
    return int(match.group()) if match else 999999999


def render_markdown(beads: Beads, feature_key: str) -> tuple[str, dict[str, Any]]:
    epic_ref = f"speckit:{feature_key}"
    issues = beads.list_all()
    epic_summary = next((issue for issue in issues if issue.get("external_ref") == epic_ref), None)
    if not epic_summary:
        raise TaskGraphError(f"no Beads epic found for feature {feature_key}")
    epic = beads.show(epic_summary["id"])
    tasks = [
        beads.show(issue["id"])
        for issue in issues
        if isinstance(issue.get("external_ref"), str)
        and issue["external_ref"].startswith(f"{epic_ref}:")
        and issue.get("issue_type") == "task"
    ]
    if not tasks:
        raise TaskGraphError(f"no Beads tasks found for feature {feature_key}")

    id_by_ref = {issue["external_ref"]: issue for issue in tasks}
    dependencies: dict[str, list[str]] = {}
    for issue in tasks:
        refs = [
            ref
            for dependency in beads.dependencies(issue["id"])
            if (ref := dependency_ref(dependency)) in id_by_ref
        ]
        dependencies[issue["external_ref"]] = refs

    indegree = {ref: len(refs) for ref, refs in dependencies.items()}
    dependents: dict[str, list[str]] = {ref: [] for ref in dependencies}
    for ref, dependency_refs in dependencies.items():
        for dependency_ref_value in dependency_refs:
            dependents[dependency_ref_value].append(ref)
    ready = sorted(
        (ref for ref, degree in indegree.items() if degree == 0),
        key=lambda ref: display_id_number(id_by_ref[ref]),
    )
    ordered_tasks: list[dict[str, Any]] = []
    while ready:
        ref = ready.pop(0)
        ordered_tasks.append(id_by_ref[ref])
        for dependent in dependents[ref]:
            indegree[dependent] -= 1
            if indegree[dependent] == 0:
                ready.append(dependent)
                ready.sort(key=lambda item: display_id_number(id_by_ref[item]))
    if len(ordered_tasks) != len(tasks):
        raise TaskGraphError("cannot render a cyclic Beads task graph")
    tasks = ordered_tasks

    lines = [
        f"# Tasks: {epic['title'].removeprefix('Spec Kit: ')}",
        "",
        "> Generated from Beads. Do not edit task status here; use `bd ready`, `bd update --claim`, and `bd close`.",
        "",
        f"**Beads epic**: `{epic['id']}`  ",
        f"**Feature**: `{feature_key}`",
        "",
    ]
    current_phase: str | None = None
    for issue in tasks:
        speckit = issue_metadata(issue).get("speckit", {})
        phase = str(speckit.get("phase") or "Ungrouped")
        if phase != current_phase:
            if current_phase is not None:
                lines.append("")
            lines.extend([f"## {phase}", ""])
            current_phase = phase
        marker = "x" if issue.get("status") == "closed" else " "
        display_id = str(speckit.get("display_id") or "T???")
        parallel = " [P]" if speckit.get("parallel") else ""
        story = f" [{speckit['story']}]" if speckit.get("story") else ""
        title = re.sub(r"^T\d{3,}:\s*", "", issue["title"])
        lines.append(f"- [{marker}] {display_id}{parallel}{story} {title}")

    edge_lines: list[str] = []
    for issue in tasks:
        dependency_refs = dependencies[issue["external_ref"]]
        if not dependency_refs:
            continue
        display_id = issue_metadata(issue).get("speckit", {}).get("display_id", "T???")
        dependency_ids = [
            issue_metadata(id_by_ref[ref]).get("speckit", {}).get("display_id", "T???")
            for ref in dependency_refs
        ]
        edge_lines.append(f"- `{display_id}` depends on {', '.join(f'`{item}`' for item in dependency_ids)}")
    lines.extend(["", "## Dependencies", ""])
    lines.extend(edge_lines or ["- No internal task dependencies."])
    lines.append("")
    return "\n".join(lines), epic


def task_summary(issue: dict[str, Any]) -> dict[str, Any]:
    speckit = issue_metadata(issue).get("speckit", {})
    return {
        "id": issue["id"],
        "display_id": speckit.get("display_id"),
        "task_key": speckit.get("task_key"),
        "phase": speckit.get("phase"),
        "story": speckit.get("story"),
        "parallel": speckit.get("parallel", False),
        "title": issue["title"],
        "status": issue.get("status"),
        "priority": issue.get("priority"),
    }


def task_sort_key(issue: dict[str, Any]) -> tuple[int, int]:
    priority = issue.get("priority")
    return (
        priority if isinstance(priority, int) else 4,
        display_id_number(issue),
    )


def dag_status(beads: Beads, feature_key: str) -> dict[str, Any]:
    epic_ref = f"speckit:{feature_key}"
    summaries = beads.list_all()
    epic_summary = next(
        (issue for issue in summaries if issue.get("external_ref") == epic_ref), None
    )
    if not epic_summary:
        raise TaskGraphError(f"no Beads epic found for feature {feature_key}")
    epic = beads.show(epic_summary["id"])
    tasks = [
        beads.show(issue["id"])
        for issue in summaries
        if isinstance(issue.get("external_ref"), str)
        and issue["external_ref"].startswith(f"{epic_ref}:")
        and issue.get("issue_type") == "task"
    ]
    if not tasks:
        raise TaskGraphError(f"no Beads tasks found for feature {feature_key}")

    by_ref = {issue["external_ref"]: issue for issue in tasks}
    internal_dependencies: dict[str, set[str]] = {}
    external_blockers: dict[str, list[dict[str, Any]]] = {}
    for issue in tasks:
        internal: set[str] = set()
        external: list[dict[str, Any]] = []
        for dependency in beads.dependencies(issue["id"]):
            ref = dependency_ref(dependency)
            if ref in by_ref:
                internal.add(ref)
            elif dependency.get("status") != "closed":
                external.append(
                    {
                        "id": dependency.get("id"),
                        "title": dependency.get("title"),
                        "status": dependency.get("status"),
                    }
                )
        internal_dependencies[issue["external_ref"]] = internal
        external_blockers[issue["external_ref"]] = external

    closed_refs = {
        ref for ref, issue in by_ref.items() if issue.get("status") == "closed"
    }
    closed = sorted((by_ref[ref] for ref in closed_refs), key=task_sort_key)
    completed = set(closed_refs)
    remaining = {
        ref
        for ref, issue in by_ref.items()
        if issue.get("status") != "closed"
    }
    waves: list[dict[str, Any]] = []
    wave_number = 0
    while remaining:
        wave_refs = [
            ref
            for ref in remaining
            if by_ref[ref].get("status") in {"open", "in_progress"}
            and internal_dependencies[ref].issubset(completed)
            and not external_blockers[ref]
        ]
        if not wave_refs:
            break
        wave_issues = sorted((by_ref[ref] for ref in wave_refs), key=task_sort_key)
        waves.append(
            {
                "wave": wave_number,
                "tasks": [task_summary(issue) for issue in wave_issues],
            }
        )
        completed.update(wave_refs)
        remaining.difference_update(wave_refs)
        wave_number += 1

    blocked: list[dict[str, Any]] = []
    for ref in sorted(remaining, key=lambda value: task_sort_key(by_ref[value])):
        issue = by_ref[ref]
        internal = [
            task_summary(by_ref[dependency])
            for dependency in sorted(
                internal_dependencies[ref] - completed,
                key=lambda value: task_sort_key(by_ref[value]),
            )
        ]
        blocked.append(
            {
                **task_summary(issue),
                "blocked_by": internal,
                "external_blockers": external_blockers[ref],
                "state_blocker": (
                    issue.get("status")
                    if issue.get("status") not in {"open", "in_progress"}
                    else None
                ),
            }
        )

    current_wave = waves[0]["tasks"] if waves else []
    return {
        "feature": feature_key,
        "epic": {"id": epic["id"], "title": epic["title"], "status": epic.get("status")},
        "counts": {
            "total": len(tasks),
            "closed": len(closed),
            "remaining": len(tasks) - len(closed),
            "ready_or_in_progress": len(current_wave),
            "blocked": len(blocked),
        },
        "current": current_wave,
        "waves": waves,
        "blocked": blocked,
        "closed": [task_summary(issue) for issue in closed],
    }


def safe_output_path(project_root: Path, output: Path, epic: dict[str, Any]) -> Path:
    metadata = issue_metadata(epic).get("speckit", {})
    feature_dir = metadata.get("feature_dir")
    if not isinstance(feature_dir, str):
        raise TaskGraphError("epic metadata does not contain feature_dir")
    expected = (project_root / feature_dir / "tasks.md").absolute()
    candidate = output if output.is_absolute() else project_root / output
    candidate = candidate.absolute()
    if candidate != expected:
        raise TaskGraphError(f"output must be the feature compatibility file: {expected}")
    if has_symlink_component(project_root, candidate):
        raise TaskGraphError("output traverses a symlink or leaves the project")
    candidate.parent.resolve(strict=True).relative_to(project_root.resolve())
    return candidate


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    reconcile_parser = subparsers.add_parser("reconcile", help="Reconcile a JSON task graph into Beads")
    reconcile_parser.add_argument("--project-root", type=Path, default=Path.cwd())
    reconcile_parser.add_argument("--graph", type=Path, required=True)
    reconcile_parser.add_argument("--apply", action="store_true")

    render_parser = subparsers.add_parser("render", help="Render tasks.md from Beads")
    render_parser.add_argument("--project-root", type=Path, default=Path.cwd())
    render_parser.add_argument("--feature", required=True)
    render_parser.add_argument("--output", type=Path)
    render_parser.add_argument("--apply", action="store_true")

    status_parser = subparsers.add_parser("status", help="Show readiness and execution waves")
    status_parser.add_argument("--project-root", type=Path, default=Path.cwd())
    status_parser.add_argument("--feature", required=True)
    return parser.parse_args(argv)


def find_project_root(start: Path) -> Path:
    current = start.resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".specify").is_dir() and (candidate / ".beads").is_dir():
            return candidate
    raise TaskGraphError("could not find a project root containing .specify/ and .beads/")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        project_root = find_project_root(args.project_root)
        if args.command == "reconcile":
            result = reconcile(project_root, args.graph, args.apply)
            print(json.dumps(result, indent=2, sort_keys=True))
        elif args.command == "render":
            markdown, epic = render_markdown(Beads(project_root), args.feature)
            if args.apply:
                if not args.output:
                    raise TaskGraphError("--output is required with --apply")
                output = safe_output_path(project_root, args.output, epic)
                output.write_text(markdown)
                print(json.dumps({"feature": args.feature, "output": str(output)}, indent=2))
            else:
                print(markdown, end="")
        else:
            print(json.dumps(dag_status(Beads(project_root), args.feature), indent=2, sort_keys=True))
    except (OSError, TaskGraphError) as exc:
        print(json.dumps({"error": str(exc)}, indent=2), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
