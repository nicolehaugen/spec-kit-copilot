# Canvas Design

A Spec Kit extension that supplies settings pages, a page-loading command and
an Essentials-driven workflow canvas generation command for the Copilot Designer.

## What It Does

Canvas Design **0.1.18** registers three JSON page templates, five ordered
stock field templates, reusable text and checkbox definitions with Designer
adapters, a shared image definition with paired adapters, and a source-owned
Workflow page definition and pipeline renderer, plus the
`speckit.extension-canvas-design.load-page` and
`speckit.extension-canvas-design.generate` commands. The first resolves the
project's preset-composed pages and explicitly named contribution templates,
then opens the Designer with the complete resolved set.
The second writes a maintained SDK entry point and workflow modules into a new
project extension directory, then validates the result in place.

Replaceable templates are organized by host: `designer/` contains Designer
tabs and settings, while `generated/pages/` contains the Workflow definition
and pipeline renderer. `templates/generated-canvas/` is the static app
scaffold; Generate copies the resolved `generated/` assets into its `pages/`
directory, so the finished app does not depend on this extension at runtime.

| Template | Page | Default contents |
| --- | --- | --- |
| `designer-essentials` | Essentials | Required Canvas ID and Title |
| `designer-essentials-description` | Essentials slot | Optional Description |
| `designer-essentials-workflow-heading` | Essentials slot | Optional Workflow header |
| `designer-essentials-custom-slug` | Essentials slot | Optional Allow custom slug |
| `designer-essentials-header-logo` | Essentials slot | Optional small header logo |
| `designer-essentials-main-page-logo` | Essentials slot | Optional larger main-page logo |
| `generated-workflow` | Generated Workflow page | Ordered, required host regions |
| `generated-pipeline` | Generated Workflow page | Replaceable phase navigation and card presentation |
| `shared-controls-image` | Shared control | Image value contract and paired adapter names |
| `designer-control-adapter-image` | Designer | Upload, preview, replace, and remove images |
| `generated-control-adapter-image` | Generated app | Render packaged images in authorized slots |
| `shared-controls-text` | Shared control | String value contract and adapter names |
| `designer-control-adapter-text` | Designer | Edit text, including required Canvas ID and Title |
| `generated-control-adapter-text` | Generated app | Render visible text in authorized placements |
| `shared-controls-checkbox` | Shared control | Boolean value contract and Designer adapter name |
| `designer-control-adapter-checkbox` | Designer | Edit boolean settings |
| `designer-artifacts` | Outputs | Review fixed pipeline artifacts, add viewer links, and select the default viewer target |
| `designer-appearance` | Appearance | Empty placeholder |

The Essentials core template lives in `designer/tabs/essentials.json`; its
`designer-essentials` is the template ID used for preset resolution.
Its required Canvas ID and Title are fixed fields that share the `stock.text`
editor with optional text contributions; a preset cannot remove them by
omitting an optional contribution. Field-specific length, requiredness, and
identifier rules are shown and validated by the Designer adapter at Generate;
the generator independently guards the generated extension path. Description and
Workflow header use the packaged stock-text adapter for their visible
generated presentation. Authors may set `"required": true` on a text field
in a page or a field contribution to reject empty or whitespace-only values.
The shared Designer adapter shows the field's syntax guidance; Generate verifies
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
The Designer accepts up to ten selected 32 KiB images; its Save and frozen
generation size limits accommodate that maximum, while still rejecting
oversized aggregate requests explicitly.
Each image contribution uses `"control": "stock.image"` to select the uniquely
resolved shared definition; its `generatedBinding` declares the target slot.
Missing or duplicate definitions fail validation. Presets reuse the definition and both adapters rather than supplying
per-placement image renderers. The resulting app serves its own images and
loads its packaged adapter without Canvas Design installed. It rejects missing
or modified packaged images instead of silently rendering a different logo.
Without a Header logo the existing brand mark remains; a configured image
that cannot mount its adapter shows a local error.
Both adapters receive an image-source string as `value`. Designer supplies
the editable data URI and upload processing in the Designer adapter; the generated
host supplies an authorized packaged URL as `value` and presentation options
such as alt text in `context`. Neither adapter selects a slot or reads files.

Preset-generated pages can also place a `stock.image` contribution. Declare a
slot on the generated page, for example
`"slots": [{"id": "hero.logo"}]`, and bind the image
field with `"control": "stock.image"` and
`"generatedBinding": {"presentation": "asset",
"page": "canvas-generated-gallery", "slot": "hero.logo"}`. The page renderer
puts a `<div data-asset-slot="hero.logo"></div>` at the desired location; the
generated host matches the slot ID and mounts the packaged image there, with
the field label as its accessible description. The renderer may style the slot to choose the size
and layout. Every page, field, and renderer must be explicitly registered as
a named replace-only template. Unknown or duplicate slots fail
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
Deletion verifies the directory and its parent, moves it to a temporary
location, and checks the moved directory's identity before removing it. If
the parent changes during deletion, the moved directory is retained for manual
recovery at the path shown in the error.
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
The Outputs tab shows one phase at a time, except Constitution. Wizard-inferred
pipeline artifacts cannot be edited or removed; users can add and remove separate
Markdown artifact links and choose the View artifact default. Adding a link does
not create the file or change what the pipeline produces. Removing a selected
addition restores the phase's original viewer default. The generated phase card
lists all links and opens the selected one; View artifact is hidden when a phase
has none. Constitution always opens `.specify/memory/constitution.md` and cannot
be changed in the Designer. Existing header Save persists the viewer selections
and additional links.

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
specify extension add extension-canvas-design --from https://github.com/nicolehaugen/spec-kit-copilot/releases/download/extension-canvas-design-v0.1.18/extension-canvas-design.zip
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
field collision; newly registered stock text/checkbox fields mount their
resolved Designer adapters on their declared Designer page and can be saved.
A registered bounded string contribution with
`generatedBinding: {"presentation": "stock.readonly"}` also freezes its
validated value into a read-only generated display, regardless of
which declared Designer slot holds the field. A separately registered
`generated.added-page-definition` definition and `generated.added-page-renderer` `.mjs` template add a
generated-only page without a Designer tab. The renderer is a complete
replace-only Specify template exporting `renderPage({ root, canvas, values })`;
the definition must name that registered renderer. Invalid kinds, references,
strategies, syntax or Specify template-layer metadata stop Designer opening.
Page IDs and renderer names must also be portable filenames: Windows device
names such as `con`, `nul`, and `com1` are rejected before generation.
Switching to a generated page hides Workflow-owned content and restores it on
return; the canvas header and status remain available on either page.
The frozen definition and module are copied into the generated app, which
needs no design-time packages to render them. A typed object field can use a
shared `shared.control-definition` naming separate replace-only `designer.control-adapter`
and `generated.control-adapter` templates; each module exports `mount`, `controlId`,
and `valueContract`. Each object-field contribution requires exactly one
`shared.control-definition` template matching its `field.control`, and Generate uses
that validated template name. Template names cannot be Windows device names because they may become packaged filenames.
The Designer adapter receives
`{root, field, value, onChange}`; the generated adapter receives
`{root, field, value}`. Designer saves drafts, including incomplete values; Generate
freezes the validated object and packages the effective generated adapter and
definition into the app, up to 30 generated controls. The frozen request holds
one asset pair per control ID; each field registration refers to that pair by
its control ID, so reused controls do not repeat module bytes. Missing, wrong-kind,
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
declaration (without imports). Named re-exports are unsupported.

Provider module names must be portable filenames, not Windows device names
such as `con`, `com1`, or `lpt9`. Designer, the frozen-request materializer,
and the generated app each enforce this before using `providers/<module>.mjs`.

For example:

```js
export function provideValue({ workflow }) {
    return `${workflow.label} (${workflow.slug})`;
}
```

`workflow` is a read-only object with `id`, `slug`, and `label` for the selected
existing workflow. Return a synchronous, JSON-serializable value matching the
value definition's typed schema; do not use `async` or return a Promise.
Designer checks the direct export and transformed script syntax, but **does not
run the provider**. A non-function export, Promise, invalid typed result, or
provider error is reported on generated-canvas refresh, not silently replaced.
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
The Designer, generator, and standalone generated app apply the same object
contract and value rules: 1-10 named properties, each with 1-20 distinct,
nonempty string options of at most 80 characters. The canonical
`templates/generated-canvas/control-contract.mjs` is copied into generated apps;
the Wizard provider includes a byte-checked copy, without a runtime dependency
on the design-time extension.
The browser reports incompatible `controlId` or `valueContract` exports,
non-function `mount` exports, and mount failures beside the affected control.
The frozen generation request is bounded to 4 MiB, allowing registered assets
to be packaged after base64 encoding while retaining the 32 KiB limit on each
definition and renderer.
Designer derives generated field and control registrations only from resolved
`generatedBinding` contributions when freezing. All validated Designer values
remain in the request, including Designer-only values, but only bound values
become generated displays. The generator checks registrations against frozen
value constraints and control definitions, as well as file and asset limits.
The request's SHA-256 integrity value catches accidental edits; it is not an
authentication mechanism for a locally rewritten and re-signed request.
For stock read-only fields, an optional `generatedBinding.section` with a
stable `id` and display `title` groups fields under that heading without
changing the Designer slot; fields without a section keep the **Configured
fields** heading. Opening the shell does not mean all pages loaded or that
Essentials is valid for generation.

The repository-local `copilot-billing-canvas-test` preset exercises stock
read-only placement on Billing and Essentials. The isolated
[test-only preset](../../spec-kit-presets/copilot-canvas-design-test/preset.yml)
registers an additional Designer page with stock text and checkbox fields. The
browser integration test covers the checkbox default, rendering, save, and
reopen. The preset is installed locally, not published in the canonical preset
catalog. Billing and generated-only pages have separate test fixtures.

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
| `designer.tab-definition` | Required or added Designer tab | [tab](schemas/designer.tab-definition.schema.json) |
| `designer.setting-definition` | Field placed in a Designer tab slot | [setting](schemas/designer.setting-definition.schema.json) |
| `generated.workflow-page-definition` | Required generated Workflow layout | [Workflow page](schemas/generated.workflow-page-definition.schema.json) |
| `generated.pipeline-renderer` | Workflow pipeline `.mjs` presentation | Module contract below |
| `generated.added-page-definition` | Generated-only page | [generated page](schemas/generated.added-page-definition.schema.json) |
| `generated.added-page-renderer` | Generated-only `.mjs` renderer | Module contract below |
| `shared.control-definition` | Shared typed control | [shared control](schemas/shared.control-definition.schema.json) |
| `designer.control-adapter` | Designer `.mjs` control adapter | Module contract below |
| `generated.control-adapter` | Generated `.mjs` control adapter | Module contract below |
| `generated.value-definition` | Generated constant or computed value | [generated value](schemas/generated.value-definition.schema.json) |
| `generated.computed-value-provider` | Generated `.mjs` provider | Module contract below |

Each JSON kind has a matching schema filename. The three required tabs are
identified by their registered names; added tabs use the same document shape.
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

The required `generated-workflow` definition has `id: "workflow"`, a `pipeline`
reference to the registered `generated.pipeline-renderer`, and an ordered
`regions` array containing each of `collection`, `details`, `values`,
`controls`, `pages`, `constitution`, `message`, and `pipeline` exactly once.
The generated host renders these regions in the declared order. Presets may
replace the whole JSON template to reorder them, but cannot remove host
regions, invent new ones, or change the phase-dispatch rules. Regions without
configured content render nothing. This is intentionally distinct from an
added generated page's `renderPage` contract.

The pipeline module exports `mount({ root, phases, actions })`. It owns the
navigation and selected-phase card within `root` and returns `{ steps }`, an
ordered array of its phase buttons. `phases` contains `{ id, label, output, outputs }`
display data; the host supplies `actions.select(index, focusId?)`,
`actions.run(args)`, `actions.view(output?)`, `actions.reveal()`,
`actions.draft(value)`, and `actions.error(error)`. The first four request
host-validated operations; adapters do not call workflow endpoints directly.
For this initial proof, the renderer must retain the host's documented
`phase-navigation`, `phase-card`, `phase-args`, status/action IDs,
`data-phase-index`/`data-phase-label` buttons and `phase-template-N` elements
used for state and focus updates. The test-only vertical preset demonstrates
replacing the module while retaining those interactions; a fully independent
feature-control lifecycle is a later milestone. A minimal static phase list:

```js
export function mount({ root, phases, actions }) {
  const list = document.createElement("ol");
  const steps = phases.map((phase, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.phaseIndex = String(index);
    button.dataset.phaseLabel = phase.label;
    button.textContent = phase.label;
    button.addEventListener("click", () =>
      Promise.resolve(actions.select(index)).catch(actions.error));
    const item = document.createElement("li");
    item.append(button);
    list.append(item);
    return button;
  });
  root.replaceChildren(list);
  return { steps };
}
```

The snippet illustrates the callback shape only; a working replacement must
also render the required phase card and status/action elements. See
[`generated-pipeline`](generated/pages/generated-pipeline.mjs)
for the complete stock implementation. Module imports are not packaged.

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
`id` and a `valueContract` object matching its `value`. A Designer adapter also
exports a pure, synchronous `validate(value, field): boolean` and
`mount({ root, field, value, onChange })`, returning `{ isReady(): boolean }`.
`field.validation` is the resolved field's canonical rule object: string fields
receive `type`, `maxLength`, and optional `minLength`, `required`, `pattern`, and
`forbiddenValues`; object fields receive `type` and `properties`; image fields
receive `type`, `maxBytes`, and `mimeTypes`. Canvas ID includes its reserved
IDs in `forbiddenValues`. The Designer derives these rules from approved fields,
not request bodies. A shared adapter checks the rules, not specific field IDs.
The validator must not access browser globals or return a Promise: Generate
executes the approved, hash-checked module in local Node. A false result shows
the host's field-ID-and-label error; thrown errors are reported separately.
Save stores bounded, mountable drafts without invoking `validate`, including
incomplete values; Generate validates the values it freezes. The generator
independently checks its output identity, paths, and frozen request, but cannot
prove every custom adapter's semantics if a replacement ignores its rules.

### Reducing customization breakage

Preset adapters can break if they depend on the Designer's internal layout,
CSS, or validation logic when those internals change. The Designer creates a
separate, initially empty `<div>` for each control and passes it as `root`.
Adapters must not query, modify, or style elements outside that div, or rely on
the surrounding page's CSS. This is a compatibility contract, not JavaScript
isolation; approved adapter modules are trusted code.

The adapter owns how its control works. On an edit, it calls `onChange(value)`
to give the Designer a new unsaved draft value without remounting. It does not
need to know how the Designer stores drafts, switches tabs, or saves settings.
It returns an `isReady()` handle to report unfinished work and exports
`validate(value, field)` to check whether its value is acceptable. The Designer
calls these functions without depending on the adapter's UI or internal
validation logic. An image adapter keeps readiness false during upload and
after failure until retry or explicit cancellation; it owns decoding, upload
progress, and errors.

Save can retain unfinished work. The browser checks `isReady()` before Save,
Generate, or leaving the tab; the server invokes the approved adapter's
validator on the values it will freeze before creating a canvas. Keeping these
responsibilities behind a small, documented contract lets the Designer evolve
without requiring presets to follow changes to its internals. There is no
public Designer `context` or readiness callback.

Generated adapters have a separate contract: they receive
`{ root, field, value, context }`, with generated-only presentation information
such as `alt` and `className`.
`stock.checkbox` has only a Designer adapter; generated presentation is
required for image, text and object controls. A minimal pair
for a control with `{type:"object",properties:{level:["low","high"]}}`:

```js
export const controlId = "rating";
export const valueContract = { type: "object", properties: { level: ["low", "high"] } };
export function validate(value, field) {
  return field.validation.type === "object"
    && value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).join() === "level"
    && field.validation.properties.level.includes(value.level);
}
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
  return { isReady: () => true };
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
