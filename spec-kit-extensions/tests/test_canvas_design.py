import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from zipfile import ZipFile

import yaml
from jsonschema import Draft202012Validator, ValidationError


EXTENSIONS = Path(__file__).resolve().parents[1]
EXTENSION_ID = "extension-canvas-design"
PACKAGE = EXTENSIONS / EXTENSION_ID
PAGE_NAMES = ("essentials", "outputs", "appearance")
PAGE_IDS = ("essentials", "artifacts", "appearance")
FILES = {
    "extension.yml",
    "README.md",
    "ARCHITECTURE.md",
    "commands/load-page.md",
    "commands/generate.md",
    "scripts/generate.mjs",
    "scripts/verify-launch.mjs",
    "schemas/designer.tab-definition.schema.json",
    "schemas/designer.setting-definition.schema.json",
    "schemas/generated.added-page-definition.schema.json",
    "schemas/generated.workflow-page-definition.schema.json",
    "schemas/generated.phase-control-definition.schema.json",
    "schemas/generated.phase-control-placement.schema.json",
    "schemas/generated.field-placement.schema.json",
    "schemas/shared.control-definition.schema.json",
    "schemas/generated.value-definition.schema.json",
    *(f"designer-host/tabs/{name}.json" for name in PAGE_NAMES),
    *(f"designer-host/essentials-settings/{name}.json" for name in (
        "description", "workflow-heading", "custom-slug", "header-logo", "main-page-logo",
    )),
    "shared-controls/stock-image/control.json",
    "shared-controls/stock-image/designer.mjs",
    "shared-controls/stock-image/generated.mjs",
    "shared-controls/stock-text/control.json",
    "shared-controls/stock-text/designer.mjs",
    "shared-controls/stock-text/generated.mjs",
    "shared-controls/stock-checkbox/control.json",
    "shared-controls/stock-checkbox/designer.mjs",
    "generated-host/workflow/workflow.json",
    "generated-host/workflow/generated-phase-placement.json",
    "generated-host/phase-control/phase-control.json",
    "generated-host/phase-control/generated-phase-adapter.mjs",
    *(f"templates/generated-canvas/{name}" for name in (
        "extension.mjs", "server.mjs", "runtime.mjs", "contract.mjs", "control-contract.mjs", "files.mjs",
        "phase-response.mjs",
        "ui/app.js", "ui/markdown.mjs", "ui/runtime.css", "ui/workflow-theme.css",
        "ui/page-assets.mjs",
    )),
}


class CanvasDesignPackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = yaml.safe_load((PACKAGE / "extension.yml").read_text("utf-8"))
        cls.catalog = json.loads((EXTENSIONS / "catalog.json").read_text("utf-8"))
        cls.schema = json.loads((PACKAGE / "schemas/designer.tab-definition.schema.json").read_text("utf-8"))
        cls.validator = Draft202012Validator(cls.schema)
        cls.pages = [
            json.loads((PACKAGE / f"designer-host/tabs/{name}.json").read_text("utf-8"))
            for name in PAGE_NAMES
        ]
        cls.command = (PACKAGE / "commands/load-page.md").read_text("utf-8")
        cls.workflow = yaml.load(
            (EXTENSIONS.parent / ".github/workflows/release-extension.yml").read_text("utf-8"),
            Loader=yaml.BaseLoader,
        )

    def workflow_python(self, step_name):
        step = next(
            step for step in self.workflow["jobs"]["package"]["steps"]
            if step.get("name") == step_name
        )
        lines = step["run"].strip().splitlines()
        self.assertEqual(lines[0], "python - <<'PY'")
        self.assertEqual(lines[-1], "PY")
        return "\n".join(lines[1:-1])

    def test_manifest_and_shipped_files(self):
        self.assertEqual(self.manifest["schema_version"], "1.0")
        extension = self.manifest["extension"]
        self.assertEqual(extension["id"], EXTENSION_ID)
        self.assertRegex(extension["version"], r"^\d+\.\d+\.\d+$")
        self.assertIn(
            f'Canvas Design **{extension["version"]}**',
            (PACKAGE / "README.md").read_text("utf-8"),
        )
        self.assertEqual(self.manifest["requires"], {"speckit_version": ">=1.0.7"})
        self.assertEqual(
            set(self.manifest["provides"]), {"commands", "templates"}
        )
        self.assertEqual(
            [(command["name"], command["file"])
             for command in self.manifest["provides"]["commands"]],
            [(f"speckit.{EXTENSION_ID}.load-page", "commands/load-page.md"),
             (f"speckit.{EXTENSION_ID}.generate", "commands/generate.md")],
        )
        self.assertEqual(
            [(template["name"], template["file"])
             for template in self.manifest["provides"]["templates"]],
            [(f"designer-{page}", f"designer-host/tabs/{filename}.json")
             for page, filename in zip(PAGE_IDS, PAGE_NAMES)]
            + [(f"designer-essentials-{filename}", f"designer-host/essentials-settings/{filename}.json")
               for filename in ("description", "workflow-heading", "custom-slug",
                                "header-logo", "main-page-logo")]
            + [("generated-workflow", "generated-host/workflow/workflow.json"),
               ("generated-phase-placement", "generated-host/workflow/generated-phase-placement.json"),
               ("generated-phase-control", "generated-host/phase-control/phase-control.json"),
               ("generated-phase-adapter", "generated-host/phase-control/generated-phase-adapter.mjs")]
            + [(name, f"shared-controls/stock-{control}/{filename}")
               for control in ("image", "text", "checkbox")
               for name, filename in [
                   (f"shared-controls-{control}", "control.json"),
                   (f"designer-control-adapter-{control}", "designer.mjs"),
               ] + ([(f"generated-control-adapter-{control}", "generated.mjs")]
                    if control != "checkbox" else [])],
        )
        actual_files = set()
        for path in PACKAGE.rglob("*"):
            self.assertFalse(path.is_symlink(), f"Package symlink: {path}")
            if path.is_file():
                actual_files.add(path.relative_to(PACKAGE).as_posix())
        self.assertEqual(actual_files, FILES)
        for declaration in (
            self.manifest["provides"]["commands"]
            + self.manifest["provides"]["templates"]
        ):
            path = PACKAGE / declaration["file"]
            self.assertTrue(path.resolve().is_relative_to(PACKAGE.resolve()))
            self.assertTrue(path.is_file(), declaration["file"])

    def test_copilot_catalog_matches_package(self):
        self.assertEqual(self.catalog["schema_version"], "1.0")
        catalog_url = (
            "https://raw.githubusercontent.com/nicolehaugen/spec-kit-copilot/main/"
            "spec-kit-extensions/catalog.json"
        )
        self.assertEqual(self.catalog["catalog_url"], catalog_url)
        self.assertEqual(set(self.catalog["extensions"]), {EXTENSION_ID})
        entry = self.catalog["extensions"][EXTENSION_ID]
        for field in ("id", "name", "version", "author", "repository", "license"):
            with self.subTest(field=field):
                self.assertEqual(entry[field], self.manifest["extension"][field])
        self.assertEqual(entry["requires"], self.manifest["requires"])
        self.assertEqual(entry["provides"], {
            "commands": len(self.manifest["provides"]["commands"]),
            "hooks": 0,
        })
        self.assertEqual(entry["tags"], ["copilot", "canvas-design"])
        self.assertEqual(self.manifest["tags"], entry["tags"])
        self.assertEqual(entry["description"], self.manifest["extension"]["description"])
        version = entry["version"]
        self.assertEqual(
            entry["download_url"],
            "https://github.com/nicolehaugen/spec-kit-copilot/releases/download/"
            f"{EXTENSION_ID}-v{version}/{EXTENSION_ID}.zip",
        )
        self.assertEqual(
            entry["documentation"],
            "https://github.com/nicolehaugen/spec-kit-copilot/blob/main/"
            f"spec-kit-extensions/{EXTENSION_ID}/README.md",
        )
        for path in (EXTENSIONS / "README.md", PACKAGE / "README.md"):
            with self.subTest(readme=path):
                readme = path.read_text("utf-8")
                self.assertIn(
                    f"specify extension catalog add {catalog_url} "
                    "--name spec-kit-copilot --install-allowed", readme,
                )
                self.assertIn(f"specify extension add {EXTENSION_ID}\n", readme)

    def test_schema_and_default_pages(self):
        Draft202012Validator.check_schema(self.schema)
        self.assertEqual(
            self.schema["$schema"], "https://json-schema.org/draft/2020-12/schema"
        )
        for index, page in enumerate(self.pages):
            with self.subTest(page=page["id"]):
                self.validator.validate(page)
                self.assertEqual(page["id"], f"designer-{PAGE_IDS[index]}")
                self.assertEqual(page["order"], (index + 1) * 10)
                self.assertTrue(page["enabled"])
        self.assertEqual(
            [page["title"] for page in self.pages],
            ["Essentials", "Outputs", "Appearance"],
        )
        self.assertEqual(
            self.pages[0]["fields"],
            [
                {"id": "canvas.id", "label": "Canvas ID", "control": "stock.text", "description": "Use 1–100 characters: lowercase letters (a–z), numbers (0–9), and hyphens (-). Start with a letter or number. Reserved IDs, including Windows device names like con and com1, cannot be used."},
                {"id": "canvas.displayName", "label": "Title", "control": "stock.text"},
            ],
        )
        stock = [json.loads((PACKAGE / f"designer-host/essentials-settings/{name}.json").read_text("utf-8"))
                 for name in ("description", "workflow-heading", "custom-slug")]
        self.assertEqual([item["order"] for item in stock], [10, 20, 30])
        self.assertEqual([item["slot"] for item in stock], ["essentials.options"] * 3)
        self.assertEqual([item["field"]["id"] for item in stock],
                         ["canvas.description", "canvas.workflowListName",
                          "workflowSlug.userProvided"])
        self.assertEqual(stock[-1]["field"]["default"], False)
        for name in ("description", "workflow-heading", "custom-slug"):
            self.assertIn(f"`designer-essentials-{name}` — `designer.setting-definition`, `replace`",
                          self.command)
        self.assertTrue(all(page["fields"] == [] for page in self.pages[1:]))
        field_ids = [field["id"] for page in self.pages for field in page["fields"]]
        self.assertEqual(len(field_ids), len(set(field_ids)))

    def test_all_json_contract_schemas_and_fixtures(self):
        kinds = (
            "designer.tab-definition",
            "designer.setting-definition", "generated.added-page-definition",
            "generated.workflow-page-definition",
            "shared.control-definition", "generated.value-definition",
        )
        schemas = {kind: json.loads((PACKAGE / f"schemas/{kind}.schema.json").read_text("utf-8"))
                   for kind in kinds}
        preset_tabs = list((EXTENSIONS.parent / "spec-kit-presets").glob("*/designer/tabs/*.json"))
        preset_generated_pages = list((EXTENSIONS.parent / "spec-kit-presets").glob("*/generated/pages/*.json"))
        fixtures = {
            "designer.tab-definition": [PACKAGE / f"designer-host/tabs/{name}.json" for name in PAGE_NAMES]
                + preset_tabs,
            "designer.setting-definition": list(PACKAGE.glob("designer-host/essentials-settings/*.json"))
                + list((EXTENSIONS.parent / "spec-kit-presets").glob("*/designer/settings/*.json")),
            "generated.added-page-definition": preset_generated_pages,
            "generated.workflow-page-definition": [PACKAGE / "generated-host/workflow/workflow.json"],
            "shared.control-definition": list(PACKAGE.glob("shared-controls/*/control.json"))
                + list((EXTENSIONS.parent / "spec-kit-presets").glob("*/controls/*/control.json")),
            "generated.value-definition": list((EXTENSIONS.parent / "spec-kit-presets").glob("*/values/*.json")),
        }
        self.assertTrue(all(fixtures.values()))
        for manifest_path in (EXTENSIONS.parent / "spec-kit-presets").glob("*/preset.yml"):
            manifest = yaml.safe_load(manifest_path.read_text("utf-8"))
            for template in manifest.get("provides", {}).get("templates", []):
                with self.subTest(preset=manifest_path.parent.name, template=template["name"]):
                    path = manifest_path.parent / template["file"]
                    self.assertTrue(path.is_file())
                    if path.suffix == ".json":
                        doc = json.loads(path.read_text("utf-8"))
                        if doc.get("host") == "designer" and "field" in doc:
                            self.assertIn(path, fixtures["designer.setting-definition"])
        for kind, schema in schemas.items():
            Draft202012Validator.check_schema(schema)
            validator = Draft202012Validator(schema)
            for path in fixtures[kind]:
                doc = json.loads(path.read_text("utf-8"))
                with self.subTest(kind=kind, path=str(path)):
                    validator.validate(doc)
                    if path.is_relative_to(PACKAGE):
                        self.assertEqual(doc["$schema"], os.path.relpath(
                            PACKAGE / "schemas" / f"{kind}.schema.json",
                            path.parent).replace("\\", "/"))
        for kind, obsolete in (
            ("designer.tab-definition", {"accepts": ["field"]}),
            ("designer.tab-definition", {"orderBy": ["order", "presetId", "id"]}),
            ("generated.added-page-definition", {"accepts": ["asset"]}),
        ):
            page = json.loads(fixtures[kind][0].read_text("utf-8"))
            page["slots"] = [{"id": "test.slot", **obsolete}]
            with self.subTest(kind=kind, obsolete=obsolete):
                with self.assertRaises(ValidationError):
                    Draft202012Validator(schemas[kind]).validate(page)
        generated = json.loads(fixtures["generated.added-page-definition"][0].read_text("utf-8"))
        generated["slots"] = [{"id": "same.slot"}, {"id": "same.slot"}]
        with self.assertRaises(ValidationError):
            Draft202012Validator(schemas["generated.added-page-definition"]).validate(generated)
        workflow = json.loads(fixtures["generated.workflow-page-definition"][0].read_text("utf-8"))
        workflow_validator = Draft202012Validator(schemas["generated.workflow-page-definition"])
        for slots in (
            [{"id": "workflow.summary"}],
            [{"id": "workflow.phases"}, {"id": "workflow.phases"}],
            [{"id": "workflow.summary"}, {"id": "workflow.phases"}],
        ):
            with self.subTest(slots=slots):
                with self.assertRaises(ValidationError):
                    workflow_validator.validate({**workflow, "slots": slots})
        workflow_validator.validate({**workflow, "slots": [
            {"id": "workflow.phases"}, {"id": "workflow.summary"},
        ]})
        value = json.loads((EXTENSIONS.parent / "spec-kit-presets/copilot-canvas-values-test/values/workflow.json").read_text("utf-8"))
        self.assertEqual(value["source"]["kind"], "computed")
        validator = Draft202012Validator(schemas["generated.value-definition"])
        for invalid in (
            {**value, "source": {"kind": "provider", "module": value["source"]["module"]}},
            {**value, "presentation": "stock.editable"},
            {**value, "schemaVersion": 2},
            {**value, "unexpected": True},
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValidationError):
                    validator.validate(invalid)

    def test_minimal_essentials_test_preset_registers_only_required_controls(self):
        fixture = EXTENSIONS.parent / "spec-kit-presets/copilot-minimal-essentials-test"
        manifest = yaml.safe_load((fixture / "preset.yml").read_text("utf-8"))
        self.assertEqual(manifest["preset"]["id"], "copilot-minimal-essentials-test")
        self.assertEqual(manifest["requires"]["extensions"], [EXTENSION_ID])
        self.assertEqual(manifest["provides"]["templates"], [
            {
                "type": "command",
                "name": "speckit.extension-canvas-design.load-page",
                "file": "commands/load-page.md",
                "description": "Resolve only the three default Designer pages without optional stock fields.",
                "replaces": "speckit.extension-canvas-design.load-page",
                "strategy": "replace",
            },
            {
                "type": "template",
                "name": "designer-essentials",
                "file": "designer/tabs/essentials.json",
                "description": "Replace Essentials with required identity fields only.",
                "strategy": "replace",
            },
        ])
        page = json.loads((fixture / "designer/tabs/essentials.json").read_text("utf-8"))
        self.validator.validate(page)
        self.assertEqual({key: value for key, value in page.items() if key != "$schema"},
                         {key: value for key, value in self.pages[0].items() if key != "$schema"})
        replaced = (fixture / "commands/load-page.md").read_text("utf-8")
        self.assertIn("designer-essentials", replaced)
        self.assertIn("## Canvas Design templates", replaced)
        self.assertNotIn("designer-essentials-custom-slug", replaced)
        self.assertNotIn("shared-controls-image", replaced)
        registrations = re.findall(
            r"^- `([a-z0-9-]+)` — `([^`]+)`, `([^`]+)`$", replaced, re.MULTILINE,
        )
        self.assertEqual(registrations, [
            ("generated-workflow", "generated.workflow-page-definition", "replace"),
            ("generated-phase-placement", "generated.phase-control-placement", "replace"),
            ("generated-phase-control", "generated.phase-control-definition", "replace"),
            ("generated-phase-adapter", "generated.phase-control-adapter", "replace"),
            ("shared-controls-text", "shared.control-definition", "replace"),
            ("designer-control-adapter-text", "designer.control-adapter", "replace"),
            ("generated-control-adapter-text", "generated.control-adapter", "replace"),
        ])
        self.assertNotIn(manifest["preset"]["id"],
                         json.loads((EXTENSIONS.parent / "spec-kit-presets/catalog.json")
                                    .read_text("utf-8"))["presets"])

    def test_schema_rejects_invalid_page_shapes(self):
        mutations = {
            "schema version": {"schemaVersion": 2},
            "invalid id": {"id": "../outside"},
            "long id": {"id": "a" * 81},
            "empty title": {"title": ""},
            "long title": {"title": "a" * 121},
            "long description": {"description": "a" * 1001},
            "fractional order": {"order": 1.5},
            "large order": {"order": 100001},
            "small order": {"order": -100001},
            "enabled type": {"enabled": "true"},
            "unknown property": {"html": "<input>"},
            "too many fields": {"fields": [{"id": "x", "label": "X"}] * 101},
            "unknown field property": {"fields": [{"id": "x", "label": "X", "html": ""}]},
            "missing label": {"fields": [{"id": "x"}]},
            "invalid field id": {"fields": [{"id": "1x", "label": "X"}]},
            "unsupported control": {"fields": [{"id": "x", "label": "X", "type": "html"}]},
            "default type": {"fields": [{"id": "x", "label": "X", "default": "true"}]},
        }
        for name, mutation in mutations.items():
            with self.subTest(case=name):
                page = copy.deepcopy(self.pages[0])
                page.update(mutation)
                with self.assertRaises(ValidationError):
                    self.validator.validate(page)
        for required in ("schemaVersion", "id", "title", "order", "fields"):
            with self.subTest(missing=required):
                page = copy.deepcopy(self.pages[0])
                del page[required]
                with self.assertRaises(ValidationError):
                    self.validator.validate(page)

    def test_schema_accepts_optional_field_types_and_disabled_pages(self):
        page = copy.deepcopy(self.pages[0])
        page["enabled"] = False
        page["fields"] = [
            {"id": "custom.text", "label": "Text", "type": "string"},
            {"id": "custom.flag", "label": "Flag", "type": "boolean", "default": True},
        ]
        self.validator.validate(page)
        del page["enabled"]
        self.validator.validate(page)

    def test_setting_schema_allows_required_text_fields_only(self):
        schema = json.loads((PACKAGE / "schemas/designer.setting-definition.schema.json").read_text("utf-8"))
        validator = Draft202012Validator(schema)
        setting = {
            "schemaVersion": 1, "id": "custom-setting", "host": "designer",
            "slot": "essentials.options", "order": 0,
            "field": {"id": "custom.text", "label": "Text",
                      "type": "string", "control": "stock.text", "required": True},
        }
        validator.validate(setting)
        for field, binding in (
            ({"id": "custom.flag", "label": "Flag", "type": "boolean",
              "control": "stock.checkbox", "required": True}, None),
            ({"id": "custom.object", "label": "Object", "type": "object",
              "control": "risk-matrix", "required": True},
             {"presentation": "control", "slot": "details.content"}),
            ({**setting["field"], "required": False}, None),
        ):
            with self.subTest(field=field):
                invalid = {**setting, "field": field}
                if binding is not None:
                    invalid["generatedBinding"] = binding
                with self.assertRaises(ValidationError):
                    validator.validate(invalid)

    def test_object_setting_requires_generated_binding(self):
        schema = json.loads((PACKAGE / "schemas/designer.setting-definition.schema.json").read_text("utf-8"))
        validator = Draft202012Validator(schema)
        setting = json.loads((EXTENSIONS.parent / "spec-kit-presets/copilot-risk-matrix-test"
                              / "designer/settings/risk-rating.json").read_text("utf-8"))
        validator.validate(setting)
        del setting["generatedBinding"]
        with self.assertRaises(ValidationError):
            validator.validate(setting)

    def test_setting_schema_rejects_whitespace_only_section_title(self):
        schema = json.loads((PACKAGE / "schemas/designer.setting-definition.schema.json").read_text("utf-8"))
        validator = Draft202012Validator(schema)
        setting = {
            "schemaVersion": 1, "id": "custom-setting", "host": "designer",
            "slot": "essentials.options", "order": 0,
            "field": {"id": "custom.text", "label": "Text",
                      "type": "string", "control": "stock.text"},
            "generatedBinding": {"presentation": "stock.readonly",
                                 "section": {"id": "details", "title": "Details"}},
        }
        validator.validate(setting)
        setting["generatedBinding"]["section"]["title"] = " \t "
        with self.assertRaises(ValidationError):
            validator.validate(setting)

    def test_defaults_require_explicit_boolean_type(self):
        for field_type in (None, "string", "boolean"):
            for default in (True, False):
                with self.subTest(field_type=field_type, default=default):
                    page = copy.deepcopy(self.pages[0])
                    field = {"id": "custom.field", "label": "Custom", "default": default}
                    if field_type is not None:
                        field["type"] = field_type
                    page["fields"] = [field]
                    if field_type == "boolean":
                        self.validator.validate(page)
                    else:
                        with self.assertRaises(ValidationError):
                            self.validator.validate(page)

    def test_command_contract(self):
        frontmatter = self.command.split("---", 2)
        self.assertEqual(frontmatter[0], "")
        metadata = yaml.safe_load(frontmatter[1])
        self.assertEqual(
            metadata["description"],
            self.manifest["provides"]["commands"][0]["description"],
        )
        defaults = re.findall(
            r"^- (?:Essentials \()?`(designer-[a-z]+)`(?:\))?$",
            self.command, re.M,
        )
        self.assertEqual(defaults, [f"designer-{name}" for name in PAGE_IDS])
        normalized = " ".join(self.command.split())
        for required in (
            "$ARGUMENTS", "`handoffId`",
            "Additional Designer pages", "removing duplicates",
            "specify preset resolve <name>", "Resolve the complete named inventory before",
            "Additional Canvas Design templates",
            "Preserve spaces and drive-letter colons",
            "not found` can return exit code 0",
            "Stop on missing/ambiguous results",
            "composition warning",
            "Inspect the output AND exit status",
            "complete path following the exact",
            "map the exact versionless `project override` marker to `project`",
            "strip only its trailing ` v<version>`",
            "Stop if neither form matches",
            "Never choose a file by scanning",
            'open_canvas({canvasId:"speckit-canvas-designer"',
            'extensionId:"plugin:spec-kit-copilot-wizard:speckit-canvas-designer"',
            "open the official installed Copilot provider exactly once",
            'pages:[{"name":"<default-page-name>","path":"<resolved-path>","kind":"designer.tab-definition","strategy":"replace"},',
            '{"name":"<additional-page-name>","path":"<resolved-path>","kind":"designer.tab-definition","strategy":"replace"},...]',
            'templates:[{"name":"<asset-name>","path":"<resolved-path>"',
            '"kind":"<declared-kind>","strategy":"replace"',
            "Submit all defaults, additional pages, and registered templates",
            "report the CLI error/output and stop without opening Designer",
            "do not run a Python helper or write the provider's state files yourself",
            "A successful open means only that the shell is available",
            "Designer shows page-load errors to the user",
        ):
            with self.subTest(contract=required):
                self.assertIn(required, normalized)

    def test_documented_normal_install_and_provider_boundary(self):
        readme = (PACKAGE / "README.md").read_text("utf-8")
        version = self.manifest["extension"]["version"]
        self.assertIn(
            f"specify extension add {EXTENSION_ID} --from "
            "https://github.com/nicolehaugen/spec-kit-copilot/releases/download/"
            f"{EXTENSION_ID}-v{version}/{EXTENSION_ID}.zip",
            readme,
        )
        self.assertIn('--integration copilot --integration-options="--skills"', readme)
        self.assertNotIn("--dev", readme)
        self.assertIn("does not install or open a Designer", readme)
        self.assertIn("extension release version alone does not establish", readme)

    @unittest.skipUnless(os.environ.get("CANVAS_DESIGN_ARCHIVE"), "No release ZIP supplied")
    def test_release_archive_has_exact_package_bytes(self):
        self.assert_archive_matches_package(os.environ["CANVAS_DESIGN_ARCHIVE"])

    def test_inline_workflow_packaging(self):
        with tempfile.TemporaryDirectory(prefix="canvas-design-package-") as temporary:
            root = Path(temporary)
            shutil.copytree(PACKAGE, root / "spec-kit-extensions" / EXTENSION_ID)
            result = subprocess.run(
                [sys.executable, "-c", self.workflow_python("Create extension ZIP")],
                cwd=root, env=dict(os.environ, EXTENSION_IDS=json.dumps([EXTENSION_ID])),
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assert_archive_matches_package(root / f"{EXTENSION_ID}.zip")

    def test_release_version_guards(self):
        version = self.manifest["extension"]["version"]
        tag = f"refs/tags/{EXTENSION_ID}-v{version}"
        cases = [
            ("refs/pull/1/merge", True),
            ("refs/heads/main", True),
            (tag, True),
            (f"refs/tags/{EXTENSION_ID}-v999.0.0", False),
            ("refs/tags/canvas-design-v0.1.0", False),
        ]
        with tempfile.TemporaryDirectory(prefix="canvas-design-guards-") as temporary:
            for ref, succeeds in cases:
                with self.subTest(ref=ref):
                    env = dict(os.environ, GITHUB_REF=ref, GITHUB_EVENT_NAME="push",
                               GITHUB_REPOSITORY="nicolehaugen/spec-kit-copilot",
                               GITHUB_OUTPUT=str(Path(temporary) / "output"))
                    result = subprocess.run(
                        [sys.executable, "-c", self.workflow_python("Validate release version")],
                        cwd=EXTENSIONS.parent, env=env, capture_output=True, text=True,
                    )
                    self.assertEqual(result.returncode == 0, succeeds,
                                     result.stdout + result.stderr)

    def test_release_triggers_and_permissions(self):
        triggers = self.workflow["on"]
        self.assertEqual(set(triggers), {"workflow_call", "pull_request", "push"})
        self.assertEqual(triggers["push"]["tags"], ["extension-*-v*"])
        self.assertEqual(triggers["pull_request"]["branches"], ["main"])
        self.assertEqual(self.workflow["permissions"], {"contents": "read"})
        release = self.workflow["jobs"]["release"]
        self.assertEqual(release["needs"], "package")
        self.assertEqual(release["permissions"], {"contents": "write"})
        self.assertEqual(
            release["if"],
            "github.event_name == 'workflow_dispatch' || startsWith(github.ref, 'refs/tags/extension-')",
        )
        publish = next(
            step for step in release["steps"]
            if step.get("name") == "Publish validated extension"
        )["run"]
        self.assertIn('gh release create "$TAG" "$EXTENSION_ID.zip"', publish)
        self.assertIn("--verify-tag", publish)
        self.assertIn('git push origin "refs/tags/$TAG"', release["steps"][-2]["run"])

    def test_release_rejects_catalog_drift(self):
        version = self.manifest["extension"]["version"]
        mutations = [
            ("version", "999.0.0", "Catalog version must match"),
            ("download_url", "https://example.com/wrong.zip", "Catalog download URL must match"),
        ]
        with tempfile.TemporaryDirectory(prefix="canvas-design-catalog-") as temporary:
            root = Path(temporary)
            package = root / "spec-kit-extensions" / EXTENSION_ID
            package.mkdir(parents=True)
            shutil.copyfile(PACKAGE / "extension.yml", package / "extension.yml")
            (package / "schemas").mkdir()
            shutil.copyfile(PACKAGE / "schemas/designer.tab-definition.schema.json",
                            package / "schemas/designer.tab-definition.schema.json")
            designer = root / "plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer"
            designer.mkdir(parents=True)
            shutil.copyfile(
                EXTENSIONS.parent / "plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/designer-contract.json",
                designer / "designer-contract.json",
            )
            for field, value, error in mutations:
                with self.subTest(field=field):
                    catalog = copy.deepcopy(self.catalog)
                    catalog["extensions"][EXTENSION_ID][field] = value
                    (package.parent / "catalog.json").write_text(json.dumps(catalog), "utf-8")
                    result = subprocess.run(
                        [sys.executable, "-c", self.workflow_python("Validate release version")],
                        cwd=root,
                        env=dict(os.environ, GITHUB_REF=f"refs/tags/{EXTENSION_ID}-v{version}",
                                 GITHUB_EVENT_NAME="push",
                                 GITHUB_REPOSITORY="nicolehaugen/spec-kit-copilot",
                                 GITHUB_OUTPUT=str(root / "output")),
                        capture_output=True, text=True,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(error, result.stderr)

    def assert_archive_matches_package(self, path):
        with ZipFile(path) as archive:
            members = archive.infolist()
            self.assertEqual(len(members), len(FILES), "Duplicate or extra ZIP entries")
            self.assertEqual({entry.filename for entry in members}, FILES)
            self.assertIsNone(archive.testzip())
            for entry in members:
                with self.subTest(member=entry.filename):
                    self.assertFalse(entry.is_dir())
                    self.assertEqual(
                        archive.read(entry),
                        (PACKAGE / entry.filename).read_bytes(),
                    )


if __name__ == "__main__":
    unittest.main()
