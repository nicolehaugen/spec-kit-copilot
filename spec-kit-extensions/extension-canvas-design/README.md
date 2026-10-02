# Canvas Design

A Spec Kit extension that supplies settings pages, a page-loading command and
an Essentials-driven workflow canvas generation command for the Copilot Designer.

## What It Does

Canvas Design **0.1.5** registers three JSON page templates and the
`speckit.extension-canvas-design.load-page` and
`speckit.extension-canvas-design.generate` commands. The first resolves the
project's preset-composed pages and explicitly named contribution templates,
then opens the Designer with the complete resolved set.
The second writes a maintained SDK entry point and workflow modules into a new
project extension directory, then validates the result in place.

| Template | Page | Default contents |
| --- | --- | --- |
| `canvas-settings-setup` | Essentials | Canvas ID, Title, Description, Workflow header, Allow custom slug |
| `canvas-settings-artifacts` | Artifacts | Empty placeholder |
| `canvas-settings-appearance` | Appearance | Empty placeholder |

The Essentials template lives in `pages/essentials.json`; its
`canvas-settings-setup` ID stays stable for preset resolution.

The package includes the page schema and workflow feature modules, but not the
Designer provider. Generate uses Essentials, selected phases and verified
runtime package inventory from the Wizard handoff. Designer-only `canvas-design`
selections are not runtime canvas configuration. Artifacts and Appearance
settings are not yet used for generation; existing generated canvases are not
updated. Result badges are deferred; generation does not configure or render them.

The Workflow header names the collection with the description just below it.
The generated canvas groups the New action in that header; a bounded, searchable
workflow list is the selector. Project Constitution follows the workflow list
when selected. Before any workflows exist, a bordered first-workflow row takes
the list's place and starts a new workflow without leaving a detached status
message.
Each row offers a confirmed Delete action that permanently removes that
workflow directory and its contents from the checkout, not other workflows.
An optional **Workflow name**
appears just below it while creating a workflow; it labels the workflow in
the canvas (falling back to the actual directory name when blank) and does not
affect paths.
Essentials' **Allow custom slug** setting is off by default. When enabled,
an optional **Artifact directory slug** field sits beside Workflow name. Typing a slug
updates View target to preview that folder; leaving it blank, or leaving
the setting off, lets the installed Specify skill choose the directory name.
The actual directory name, including any numeric prefix, binds artifacts.
Project Constitution appears as a compact status row, expanding when setup
needs action. On narrow screens, a phase chooser shows the current step and
the next phase instead of a horizontally clipped step ribbon. Phase navigation
shows phase names without run states; the selected phase card retains its status.
Dispatch success does not add a separate "Request sent" notice to the canvas.
View artifact opens a full-page viewer with a return-to-canvas action and no
separate Refresh button.

## Requirements

- Specify CLI **>=1.0.7** and an initialized Spec Kit project.
- GitHub Copilot with a separately installed, compatible Canvas Designer
  provider accepting the resolved pages and templates in its open input.
- A launching integration that supplies the Designer handoff.

Installing this extension does not install or open a Designer. Compatibility
with a released Wizard version is not established by this package.

## Installation

**Recommended: register the catalog once, then install by ID.** Catalogs are
discovery-only by default; `--install-allowed` permits installation:

```powershell
specify extension catalog add https://raw.githubusercontent.com/nicolehaugen/spec-kit-copilot/main/spec-kit-extensions/catalog.json --name spec-kit-copilot --install-allowed
specify extension add extension-canvas-design
```

For a one-off installation without registering the catalog, use the release ZIP:

```powershell
specify extension add extension-canvas-design --from https://github.com/nicolehaugen/spec-kit-copilot/releases/download/extension-canvas-design-v0.1.5/extension-canvas-design.zip
```

The ZIP must be published before either installation method can succeed.
For a new Copilot project, initialize it first:

```powershell
specify init . --integration copilot --integration-options="--skills"
```

Use normal installation rather than a development symlink for preset composition.
In Copilot skills mode, the command is exposed as
`speckit-extension-canvas-design-load-page`. Run `/skills reload` after installing
or changing composed skills to make them available in the current session.

## How It Works

The [page-loading command](commands/load-page.md) collects default page
names and additional page or Canvas Design template names explicitly registered
in the composed command by presets. It uses `specify preset resolve <name>`
to find each project's effective named file; package tags alone do not register
files. Only after all paths resolve does it open the official Designer provider
once with the complete set. Missing or ambiguous CLI resolutions, unsafe paths, invalid
handoffs, and an unavailable provider stop the operation before an open URL is
returned. A resolved page whose file is missing or invalid shows an error tab
with a path and reason; healthy pages stay usable. Invalid registered field
contributions stop the open with both names on a field collision; newly
registered stock text/checkbox fields render on their declared Designer page
and can be saved, but custom control modules and contributed settings are not
included in Generate yet. Opening the
shell does not mean all pages loaded or that Essentials is valid for generation.

The isolated [test-only preset](../../spec-kit-presets/copilot-canvas-design-test/preset.yml)
registers an additional Designer page and a stock text field. It is installed
locally by the browser integration test, not published in the canonical preset
catalog; Billing generation and generated-only pages remain future work.

The [Generate command](commands/generate.md) consumes a frozen, integrity-checked
request prepared by the Designer. It writes the **source-owned SDK entry point**
and packaged workflow UI, theme, routes, and runtime modules into a new
`.github/extensions/<canvas-id>/` directory, alongside the frozen configuration.
The entry point uses `joinSession` and `createCanvas` to register actions and a
loopback HTTP server with open/close lifecycle handling. Generation does not call
`create-canvas` or rewrite an SDK scaffold. It validates the completed extension
in place. An existing target stops generation without overwriting it; a failure
after creation leaves the partial target for inspection. Previously generated
canvases are not updated.

Presets can replace an existing page template or append instructions that add
pages to the command. Adding a JSON file alone does not register a new page.
Page definitions must follow the [page schema](schemas/page.schema.json).

## License

MIT
