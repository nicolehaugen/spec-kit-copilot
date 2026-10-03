# Canvas Design

A Spec Kit extension that supplies settings pages, a page-loading command and
an Essentials-driven workflow canvas generation command for the Copilot Designer.

## What It Does

Canvas Design **0.1.10** registers three JSON page templates and three ordered
stock field templates, plus the
`speckit.extension-canvas-design.load-page` and
`speckit.extension-canvas-design.generate` commands. The first resolves the
project's preset-composed pages and explicitly named contribution templates,
then opens the Designer with the complete resolved set.
The second writes a maintained SDK entry point and workflow modules into a new
project extension directory, then validates the result in place.

| Template | Page | Default contents |
| --- | --- | --- |
| `canvas-settings-setup` | Essentials | Required Canvas ID and Title |
| `canvas-stock-description` | Essentials slot | Optional Description |
| `canvas-stock-workflow-heading` | Essentials slot | Optional Workflow header |
| `canvas-stock-custom-slug` | Essentials slot | Optional Allow custom slug |
| `canvas-settings-artifacts` | Artifacts | Empty placeholder |
| `canvas-settings-appearance` | Appearance | Empty placeholder |

The Essentials core template lives in `pages/essentials.json`; its
`canvas-settings-setup` ID stays stable for preset resolution.
The composed load-page command explicitly resolves each stock contribution into
`essentials.options` in the order shown. Omitting or replacing a stock contribution
does not remove the required Canvas ID and Title. If absent, generated description
defaults to `Spec Kit workflow canvas.`, heading to `Workflows`, and custom slug
to off. Generate validates all enabled Designer pages, including custom fields;
an invalid page blocks generation until repaired.

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
specify extension add extension-canvas-design --from https://github.com/nicolehaugen/spec-kit-copilot/releases/download/extension-canvas-design-v0.1.10/extension-canvas-design.zip
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
once with the complete typed, replace-only set. Missing or ambiguous CLI
resolutions, unsafe paths, invalid handoffs, and an unavailable provider stop
the operation before an open URL is returned. A resolved page whose file is
missing or invalid shows an error tab with a path and reason; healthy pages
stay usable.

`scripts/verify-launch.mjs` reads the generated skill's declarations and
verifies each name with Specify's resolution and template-stack metadata
before returning the complete pages/templates input. It performs no
installation or provider evaluation. A warning (even on exit status 0),
missing name, resolution mismatch, or executable script collision stops the
open.

Invalid registered field contributions stop the open with both names on a
field collision; newly registered stock text/checkbox fields render on their
declared Designer page and can be saved. A registered bounded string
contribution with
`generatedBinding: {"presentation": "stock.readonly"}` also freezes its
validated value into a built-in read-only generated display, regardless of
which declared Designer slot holds the field. A separately registered
`generated.page` definition and `generated.renderer` `.mjs` template add a
generated-only page without a Designer tab. The renderer is a complete
replace-only Specify template exporting `renderPage({ root, canvas, values })`;
the definition must name that registered renderer. Invalid kinds, references,
strategies, syntax or Specify template-layer metadata stop Designer opening.
The frozen definition and module are copied into the generated app, which
needs no design-time packages to render them. A typed object field can use a
shared `control.definition` naming separate replace-only `designer.adapter`
and `generated.adapter` templates; each module exports `mount`, `controlId`,
and `valueContract`. The Designer adapter receives
`{root, field, value, onChange}`; the generated adapter receives
`{root, field, value}`. Designer validates and persists changes; Generate
freezes the validated object and packages the effective generated adapter and
definition into the app, up to 30 generated controls. Missing, wrong-kind,
non-replace, or multiply owned adapters stop Designer opening rather than
falling back to a stock control.

Canvas-wide values can also be declared in a registered `value.definition`
replace-only JSON template. Its `schemaVersion: 1`, stable `id`, `label`,
`schema` (bounded string, boolean, or enumerated object), `source`, and
`presentation` are validated against the same field registry, including
collisions with Designer fields. A constant uses
`"source":{"kind":"constant","value":...}`; a workflow-derived value uses
`"source":{"kind":"provider","module":"<registered-template-name>"}` and a
separate `value.provider` replace-only `.mjs` template exporting
`provideValue({workflow})` with a direct `export function` or `export const`
declaration (synchronous and without imports). Named re-exports are unsupported.
Designer checks that the transformed script parses, but **does not run it**.
Generate requires explicit confirmation of every resolved provider's name,
source (including project overrides), and SHA-256 hash; changed bytes require
reopening Designer and confirming again. `stock.readonly` displays a value
automatically, `stock.editable`
allows a constant's typed value to be edited through shell-owned state shared
by every workflow, and `processing-only` omits automatic display. A generated
page must explicitly list consumed IDs in its definition's `values` array;
processing-only is not a secrecy boundary. Providers require a selected
existing workflow and must return a value matching their declared schema;
refresh errors surface rather than substituting a default. A refresh has a
three-second provider budget shared by all values; providers not evaluated
before the deadline report an error instead of holding the UI indefinitely.
The packaged app
checks provider bytes against the frozen hash before each evaluation and
reports changes without running them. It does not resolve or need the
originating preset at runtime. The bounded worker/VM limits accidental hangs;
**`node:vm` is not a security boundary**. Approved provider JavaScript must be
trusted with the local user's privileges, including filesystem and network
access. Hash checks prevent unnoticed substitutions, not malicious approved
code.
The browser reports incompatible `controlId` or `valueContract` exports,
non-function `mount` exports, and mount failures beside the affected control.
For stock read-only fields, an optional `generatedBinding.section` with a
stable `id` and display `title`
groups fields under that heading without changing the Designer slot; fields
without a section keep the **Configured fields** heading. Opening the shell
does not mean all pages loaded or that Essentials is valid for generation.

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
