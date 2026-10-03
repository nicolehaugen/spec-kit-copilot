# Canvas Design

A Spec Kit extension that supplies settings pages, a page-loading command and
an Essentials-driven workflow canvas generation command for the Copilot Designer.

## What It Does

Canvas Design **0.1.15** registers three JSON page templates, five ordered
stock field templates, reusable text and checkbox definitions with Designer
adapters, and a shared image definition with paired adapters, plus the
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
| `canvas-stock-logo` | Essentials slot | Optional small header logo |
| `canvas-stock-logo-main-page` | Essentials slot | Optional larger main-page logo |
| `canvas-stock-image` | Shared control | Image value contract and paired adapter names |
| `canvas-stock-image-designer` | Designer | Upload, preview, replace, and remove images |
| `canvas-stock-image-generated` | Generated app | Render packaged images in authorized slots |
| `canvas-stock-text` | Shared control | String value contract and adapter names |
| `canvas-stock-text-designer` | Designer | Edit text, including required Canvas ID and Title |
| `canvas-stock-text-generated` | Generated app | Render visible text in authorized placements |
| `canvas-stock-checkbox` | Shared control | Boolean value contract and Designer adapter name |
| `canvas-stock-checkbox-designer` | Designer | Edit boolean settings |
| `canvas-settings-artifacts` | Artifacts | Empty placeholder |
| `canvas-settings-appearance` | Appearance | Empty placeholder |

The Essentials core template lives in `pages/essentials.json`; its
`canvas-settings-setup` ID stays stable for preset resolution.
Its required Canvas ID and Title are fixed fields that share the `stock.text`
editor with optional text contributions; a preset cannot remove them by
omitting an optional contribution. Field-specific length, requiredness, and
identifier rules remain enforced by the Designer host. Description and
Workflow header use the packaged stock-text adapter for their visible
generated presentation. Authors may set `"required": true` on a text field
in a page or a field contribution to reject empty or whitespace-only values.
The shared Designer adapter shows an inline error; Save and Generate verify
the constraint independently. Omitted `required` preserves optional text.
Allow custom slug uses the stock-checkbox editor
but only its boolean value is consumed by the generated shell; it does not
need an empty generated visual adapter. A future Setup confirm checkbox can
reuse this pattern without moving privileged setup into an adapter.
The composed load-page command explicitly resolves each stock contribution into
`essentials.options` in the order shown. Omitting or replacing a stock contribution
does not remove the required Canvas ID and Title. If absent, generated description
defaults to `Spec Kit workflow canvas.`, heading to `Workflows`, and custom slug
to off. Generate validates all enabled Designer pages, including custom fields;
an invalid page blocks generation until repaired.
The independent Header logo and Main page logo controls accept PNG, JPEG, GIF,
or WebP images up to 32 KiB each. Upload, preview, replace, and remove are
available for both in Designer. The smaller header logo replaces the existing
brand mark; the optional larger main-page logo appears next to the workflow
heading and description. Either image may be used alone. Generate freezes
each selected image's bytes and SHA-256 hash and packages it within the
generated extension, together with the frozen, shared generated adapter.
Each image contribution lists `"requires": ["canvas-stock-image"]` and
uses `"control": "stock.image"`; its `generatedBinding` declares the target
slot. Presets reuse that definition and both adapters rather than supplying
per-placement image renderers. The resulting app serves its own images and
loads its packaged adapter without Canvas Design installed. It rejects missing
or modified packaged images instead of silently rendering a different logo.
Without a Header logo the existing brand mark remains; a configured image
that cannot mount its adapter shows a local error.
Both adapters receive an image-source string as `value`. Designer supplies
the editable data URI and upload capabilities in `context`; the generated
host supplies an authorized packaged URL as `value` and presentation options
such as alt text in `context`. Neither adapter selects a slot or reads files.

Preset-generated pages can also place a `stock.image` contribution. Declare a
slot on the generated page, for example
`"slots": [{"id": "hero.logo", "accepts": ["asset"]}]`, and bind the image
field with `"requires": ["canvas-stock-image"]` and
`"generatedBinding": {"presentation": "asset",
"page": "canvas-generated-gallery", "slot": "hero.logo"}`. The page renderer
puts a `<div data-asset-slot="hero.logo"></div>` at the desired location; the
generated host mounts the packaged image there, with the field label as its
accessible description. The renderer may style the slot to choose the size
and layout. Every page, field, and renderer must be explicitly registered as
a named replace-only template. Unknown, duplicate, or incompatible slots fail
validation; a selected image whose slot is not rendered fails visibly when
the generated page opens. Neither preset files nor the Canvas Design package
are needed at runtime.

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
specify extension add extension-canvas-design --from https://github.com/nicolehaugen/spec-kit-copilot/releases/download/extension-canvas-design-v0.1.15/extension-canvas-design.zip
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
once with the complete typed, replace-only set. Missing or ambiguous CLI resolutions, unsafe paths, invalid
handoffs, and an unavailable provider stop the operation before an open URL is
returned. A resolved page whose file is missing or invalid shows an error tab
with a path and reason; healthy pages stay usable. Invalid registered field
contributions stop the open with both names on a field collision; newly
registered stock text/checkbox fields mount their resolved Designer adapters on
their declared Designer page and can be saved. A registered bounded string contribution with
`generatedBinding: {"presentation": "stock.readonly"}` also freezes its
validated value into a read-only generated display, regardless of
which declared Designer slot holds the field. A separately registered
`generated.added-page-definition` definition and `generated.added-page-renderer` `.mjs` template add a
generated-only page without a Designer tab. The renderer is a complete
replace-only Specify template exporting `renderPage({ root, canvas, values })`;
the definition must name that registered renderer. Invalid kinds, references,
strategies, syntax or Specify template-layer metadata stop Designer opening.
The frozen definition and module are copied into the generated app, which
needs no design-time packages to render them. A typed object field can use a
shared `shared.control-definition` naming separate replace-only `designer.control-adapter`
and `generated.control-adapter` templates; each module exports `mount`, `controlId`,
and `valueContract`. The Designer adapter receives
`{root, field, value, onChange}`; the generated adapter receives
`{root, field, value}`. Designer validates and persists changes; Generate
freezes the validated object and packages the effective generated adapter and
definition into the app, up to 30 generated controls. Missing, wrong-kind,
non-replace, or multiply owned adapters stop Designer opening rather than
falling back to a stock control.

Canvas-wide values can also be declared in a registered `generated.value-definition`
replace-only JSON template. Its `schemaVersion: 1`, stable `id`, `label`,
`schema` (bounded string, boolean, or enumerated object), `source`, and
`presentation` are validated against the same field registry, including
collisions with Designer fields. A constant uses
`"source":{"kind":"constant","value":...}`; a workflow-derived value uses
`"source":{"kind":"computed","module":"<registered-template-name>"}` and a
separate `generated.computed-value-provider` replace-only `.mjs` template exporting
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

## Template taxonomy and schemas

Register each named Specify template as a complete replace-only layer (extension
defaults are implicitly replace-only). The kind belongs to the *registration*,
not the JSON document. No kind is inferred from a filename.

| Kind | Shape | JSON Schema |
| --- | --- | --- |
| `designer.default-tab-definition` | Built-in Designer tab | [default tab](schemas/designer.default-tab-definition.schema.json) |
| `designer.added-tab-definition` | Additional Designer tab | [added tab](schemas/designer.added-tab-definition.schema.json) |
| `designer.setting-definition` | Field placed in a Designer tab slot | [setting](schemas/designer.setting-definition.schema.json) |
| `generated.added-page-definition` | Generated-only page | [generated page](schemas/generated.added-page-definition.schema.json) |
| `generated.added-page-renderer` | Generated-only `.mjs` renderer | Module contract below |
| `shared.control-definition` | Shared typed control | [shared control](schemas/shared.control-definition.schema.json) |
| `designer.control-adapter` | Designer `.mjs` control adapter | Module contract below |
| `generated.control-adapter` | Generated `.mjs` control adapter | Module contract below |
| `generated.value-definition` | Generated constant or computed value | [generated value](schemas/generated.value-definition.schema.json) |
| `generated.computed-value-provider` | Generated `.mjs` provider | Module contract below |

Each JSON kind has a matching schema filename. The added-tab schema references
the default-tab schema because the two kinds have the same document shape.
These schemas describe document shapes, not the entire loader:
the loader additionally verifies template-name/ID equality where applicable,
cross-template references and slots, field collisions, schema-dependent constant
values, matching adapter exports, and runtime integrity. `$schema` is optional;
in extension-owned fixtures its relative path resolves to `schemas/`. Preset
fixtures intentionally omit `$schema`: after Specify installs the extension and
preset separately, a relative path between their package roots is not portable.
Use the kind-to-schema table above when editing preset JSON.

### Executable module contracts

Modules are self-contained UTF-8 `.mjs` replace-only templates. Register every
module under its own name as well as its referencing JSON template. The generated
app packages the winning generated-host modules; it does not load source presets
at runtime. Do not import another module from a renderer or provider.

`generated.added-page-renderer` exports
`renderPage({ root, canvas, values })`. `root` is the owned DOM element;
`canvas` contains frozen canvas configuration, and `values` contains only
explicitly declared value IDs from the page definition. Asset bindings need a
matching `<div data-asset-slot="hero.logo"></div>` in the renderer:

```js
export function renderPage({ root, canvas, values }) {
  const heading = document.createElement("h2");
  heading.textContent = `${canvas.displayName}: ${values["demo.heading"] ?? ""}`;
  root.replaceChildren(heading);
}
```

Each registered control adapter exports a `controlId` string matching the control definition
`id`, a `valueContract` object matching its `value`, and
`mount({ root, field, value, context, onChange })`. `root` is exclusively owned,
`field` contains the resolved field definition, and `value` is host validated.
`onChange(nextValue)` is provided only in Designer and requests a draft update;
the adapter updates its own DOM after the call (the host does not remount it).
`stock.checkbox` has only a Designer adapter; generated presentation is
required for image, text and object controls. `context` provides host-specific image capabilities: Designer's `inputId`,
`constraints`, `validateImage` and `setBusy`, or generated `alt` and
`className`. Ordinary object controls need not use `context`. A minimal pair
for a control with `{type:"object",properties:{level:["low","high"]}}`:

```js
export const controlId = "rating";
export const valueContract = { type: "object", properties: { level: ["low", "high"] } };
export function mount({ root, field, value, onChange }) {
  const select = document.createElement("select");
  for (const level of valueContract.properties.level) {
    const option = document.createElement("option");
    option.value = option.textContent = level;
    select.append(option);
  }
  select.value = value?.level ?? "low";
  select.setAttribute("aria-label", field.label);
  select.onchange = () => onChange({ level: select.value });
  root.replaceChildren(select);
}
```

```js
export const controlId = "rating";
export const valueContract = { type: "object", properties: { level: ["low", "high"] } };
export function mount({ root, field, value }) {
  const output = document.createElement("span");
  output.textContent = `${field.label}: ${value.level}`;
  root.replaceChildren(output);
}
```

`generated.computed-value-provider` exports a *direct*
`export function provideValue({ workflow })` or
`export const provideValue = ({ workflow }) => ...`. It must return a
synchronous value matching the declared schema. `workflow` is the selected
existing workflow; no selected workflow means the provider cannot run.

```js
export function provideValue({ workflow }) {
  return workflow.label;
}
```

Designer parses but never runs provider code. Generate requires explicit
confirmation of its resolved name, provenance and hash; approved code is trusted
with the local user's privileges. Providers have a shared three-second refresh
budget; `node:vm` and hash checking do not sandbox malicious approved code.

## License

MIT
