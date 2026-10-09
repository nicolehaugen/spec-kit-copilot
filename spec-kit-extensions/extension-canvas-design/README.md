# Canvas Design

A Spec Kit extension that supplies settings pages, a page-loading command and
an Essentials-driven workflow canvas generation command for the Copilot Designer.

## What It Does

Canvas Design **0.1.19** registers four JSON page templates, fifteen ordered
stock field templates, reusable text and checkbox definitions with Designer
adapters, a shared image definition with paired adapters, and a source-owned
Workflow page definition, phase control definition with its required placement,
and phase adapter, badge types and evaluator rules, plus the
`speckit.extension-canvas-design.load-page` and
`speckit.extension-canvas-design.generate` commands. The first resolves the
project's preset-composed pages and explicitly named contribution templates,
then opens the Designer with the complete resolved set.
The second writes a maintained SDK entry point and workflow modules into a new
project extension directory, then validates the result in place.

Replaceable templates are organized by host: `designer-host/` contains Designer
tabs and settings, `generated-host/workflow-page/` contains the Workflow page,
and `generated-host/phase-control/` contains the phase control with its placement
and adapter. `shared-controls/` contains definitions and adapters used by both
hosts. `generated-scaffold/` is the static app scaffold; Generate
copies the resolved generated-host assets into its `pages/` directory, so the
finished app does not depend on this extension at runtime.
`scripts/contracts/generation-request.mjs` checks the frozen request's IDs
and SHA-256 integrity before materialization. The generated app packages
`generated-scaffold/contracts/` with agent action/response, host adapter,
contribution, and persisted workflow state rules; no design-time preset is
needed when reopening it. These files define custom workflow behavior, not
the generic `create-canvas` browser/server protocol.

| Template | Page | Default contents |
| --- | --- | --- |
| `designer-essentials` | Essentials | Required Canvas ID and Title |
| `designer-essentials-description` | Essentials slot | Optional Description |
| `designer-essentials-workflow-heading` | Essentials slot | Optional Workflow header |
| `designer-essentials-header-logo` | Appearance slot | Optional small header logo (existing template name retained) |
| `designer-essentials-main-page-logo` | Appearance slot | Optional larger main-page logo (existing template name retained) |
| `designer-appearance-light-accent` | Appearance slot | Optional light-mode accent hex |
| `designer-appearance-light-background` | Appearance slot | Optional light-mode page background |
| `designer-appearance-light-surface` | Appearance slot | Optional light-mode card surface |
| `designer-appearance-light-secondary` | Appearance slot | Optional light-mode secondary surface |
| `designer-appearance-light-text` | Appearance slot | Optional light-mode main text |
| `designer-appearance-dark-accent` | Appearance slot | Optional dark-mode accent hex |
| `designer-appearance-dark-background` | Appearance slot | Optional dark-mode page background |
| `designer-appearance-dark-surface` | Appearance slot | Optional dark-mode card surface |
| `designer-appearance-dark-secondary` | Appearance slot | Optional dark-mode secondary surface |
| `designer-appearance-dark-text` | Appearance slot | Optional dark-mode main text |
| `generated-workflow` | Generated Workflow page | Required page metadata, adapter reference, badge destinations, and named slots |
| `generated-workflow-page-adapter` | Generated Workflow page | Replaceable setup, constitution, list, summary, phase composition, values, and contribution presentation |
| `generated-phase-control` | Generated Workflow page | Phase identity, placement, adapter reference, and per-phase view labels |
| `generated-phase-adapter` | Generated Workflow page | Replaceable phase navigation and card presentation |
| `shared-controls-image` | Shared control | Image value contract and paired adapter names |
| `designer-control-adapter-image` | Designer | Upload, preview, replace, and remove images |
| `generated-control-adapter-image` | Generated app | Render packaged images in authorized slots |
| `shared-controls-text` | Shared control | String value contract and adapter names |
| `designer-control-adapter-text` | Designer | Edit contributed text fields |
| `generated-control-adapter-text` | Generated app | Render visible text in authorized placements |
| `shared-controls-checkbox` | Shared control | Boolean value contract and Designer adapter name |
| `designer-control-adapter-checkbox` | Designer | Edit boolean settings |
| `designer-artifacts` | Outputs | Review fixed pipeline artifacts, add viewer links, and select the default viewer target |
| `designer-badges` | Badges | Add opt-in result badges to workflow rows, summaries, phase cards, and individual phase outputs |
| `designer-appearance` | Appearance | Logos and per-mode palette colors |

The Essentials core template lives in `designer-host/tabs/essentials.json`; its
`designer-essentials` is the template ID used for preset resolution.
Its required Canvas ID and Title are rendered by the fixed identity control,
while optional text contributions use the registered `stock.text` adapter.
The Outputs tab uses a separate fixed phase-artifacts control. The Designer
validates each supplied page without requiring every default tab to open;
presets can still contribute to the `essentials.options` slot. An empty or
partial composition opens with inline diagnostics, but Generate requires
valid identity fields and the selected generated Workflow assets. Identity
length, requiredness, and identifier rules are checked at Generate;
the generator independently guards the generated extension path. Description and
Workflow header use the packaged stock-text adapter for their visible
generated presentation. Authors may set `"required": true` on a text field
in a page or a field contribution to reject empty or whitespace-only values.
The shared Designer adapter shows the field's syntax guidance; Generate verifies
the constraint independently. Omitted `required` preserves optional text.
The artifact folder name (slug) is collected in the generated workflow shell,
not as a Designer setting. The optional Show setup checkbox uses the stock
checkbox pattern; privileged setup stays in the generated host.
The composed load-page command explicitly resolves stock contributions into
`essentials.options` or `appearance.options` in their declared order. Omitting or replacing a stock contribution
does not remove the required Canvas ID and Title. If absent, generated description
defaults to `Spec Kit workflow canvas.` and heading to `Workflows`.
Generate validates all enabled Designer pages, including custom fields;
an invalid page blocks generation until repaired.
Appearance's independent Header logo and Main page logo controls accept PNG, JPEG, GIF,
or WebP images up to 32 KiB each. They appear before palette colors.
Upload, preview, replace, and remove are
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
selections are not runtime canvas configuration.
Appearance exposes per-mode accent, page background, card surface, secondary
surface, and main text colors. Each optional setting accepts `RRGGBB` or
`#RRGGBB` (case-insensitive), or blank. Generate validates and freezes nonblank
values as `#RRGGBB` under `appearance.light` and `appearance.dark` in the
generated canvas's `canvas-config.json`. Each blank setting retains its existing
theme color. Viewers can still switch between light and dark mode. Invalid hex
blocks Generate, but incomplete drafts may be saved. There is no color preview
or contrast warning; choose contrasting text and surfaces. Existing generated
canvases are not updated. A newly opened Badges tab has no configured badges;
no badge is evaluated or rendered until one is explicitly added.

The Workflow header names the collection with the description just below it.
The generated canvas keeps New workflow in the header and shows a bordered,
searchable workflow list immediately, with "No workflows yet" inside the empty
list. New adds a selected **Not started** row in the list, prefilled with
**Workflow 1** and **workflow-1** (then Workflow 2/workflow-2, and so on). Its
editable Workflow name comes before its required Artifact folder name (slug).
The name labels the list row; the slug previews artifact output paths and names
the directory where Specify will write them. No directory is created until
Specify runs; its scripts may add a numeric prefix to the actual directory name.
New stays available while editing, and Remove discards an unstarted row without
deleting any directory. Pending rows and their phase drafts survive a reload.
Existing rows offer a confirmed Delete action that permanently removes that
workflow directory and its contents from the checkout, not other workflows.
Deletion verifies the directory and its parent, moves it to a temporary
location, and checks the moved directory's identity before removing it. If
the parent changes during deletion, the moved directory is retained for manual
recovery at the path shown in the error.
A missing project Constitution must be created before running a
workflow, with project principles required for first-time creation; an existing `.specify/memory/constitution.md` is recognized even if
created outside the canvas, with View and Update actions. The compact project
constitution follows the workflow list and applies to every workflow. The horizontal phase ribbon remains
visible, scrolling on narrow screens, even before a new workflow is started;
phase details appear when a row is selected. Phase navigation
shows phase names without run states; the selected phase card retains its status.
Its subtitle uses the Wizard's phase description when provided, with a built-in
description for canonical phases in older handoffs instead of a command ID.
Dispatch success does not add a separate "Request sent" notice to the canvas.
Phase and Constitution run buttons read "Running" while a request is being
sent or running; they remain available for retries.
Rerunning a completed or failed phase, or a phase with an available artifact,
asks for overwrite confirmation as in the Wizard; in-flight retries do not.
View output opens a full-page viewer with a return-to-canvas action and no
separate Refresh button.
The Outputs tab shows one phase at a time, except Constitution. Wizard-inferred
pipeline artifacts cannot be edited or removed; users can add and remove separate
Markdown artifact links and choose the View artifact default. Adding a link does
not create the file or change what the pipeline produces. Removing a selected
addition restores the phase's original viewer default, or selects the first
remaining link when there is no original default. The generated phase card shows the default output first and collapses additional
links behind a count; View output is hidden when a phase has none. Running
Specify creates the workflow. Constitution always
opens `.specify/memory/constitution.md` and cannot
be changed in the Designer. Existing header Save persists the viewer selections
and additional links.

## Generated app project setup

Essentials includes **Show setup**, off by default. When enabled, an unready
project shows a setup card above a read-only preview of its selected workflow.
Phase Run actions remain unavailable until setup completes. Clicking **Set up
project** ensures the Specify CLI is available, initializes Spec Kit in Copilot
skills mode if needed, then asks for confirmation before installing any pending runtime
packages. The confirmation lists every pending package and source, including
community packages. Cancelling does not start installation. After installation
and skill reload are verified, the setup card disappears and the same workflow
enables in place. Already-ready projects skip setup. With Show setup off, the
normal page remains visible but phase runs are blocked with a setup-required
error until the project's
prerequisites are met; no automatic install runs.

Specify may report an approved direct-URL package as a local source. The
generated canvas accepts that inventory only after the confirmed URL install
completes with the frozen identity and settings, and retains an approval receipt
across restarts. A preexisting unconfirmed local installation remains pending.

Only the frozen **workflow runtime** package inventory is considered for
installation. The Canvas Design extension, `canvas-design`-tagged presets,
and local design-time customizations are already represented by their packaged
generated assets and are not installed into projects using the finished app.
Opaque bundles are not replayed: their separately verified runtime preset and
extension members are frozen and installed individually. Bundle-only components
without a verified standalone source cannot be reproduced by this setup path.
Dialog and button definitions/adapters use the same named-template resolution
and packaging as generated pages and controls. The Setup button has a dedicated
`generated-host/setup-button-control/` with a fixed setup callback; the
test preset's Workflow-page button uses a separate `dialog.trigger` control.
A preset can also bind a confirmation dialog to one selected workflow phase without replacing
the phase card or changing other phases. Project-scoped Constitution does not
support generated phase confirmations. Autopilot cannot start when any workflow
phase has a generated confirmation binding; run those phases manually instead.

The named contracts are `schemas/generated.dialog-definition.schema.json`,
`generated.phase-dialog-binding.schema.json`, `generated.button-control-definition.schema.json`,
and `generated.button-placement.schema.json`. A dialog adapter exports
`dialogId = "stock.dialog"`, `contractVersion = 1`, and
`mount({root, definition, context, onDecision})`, returning an instance (or a
promise of one) with a decision promise (`confirmed` or `cancelled`) and `dispose()`.
A button adapter exports
`controlId = "project.setup-button"`, `contractVersion = 1`, and
`mount({root, definition, onSetup})`, returning an instance (or a promise of one)
with `dispose()`. The optional
`dialog.trigger` adapter instead receives `onTrigger`. Both are executable
approved template code, not sandboxed JSON. The test-only
`spec-kit-presets/copilot-dialog-buttons-test` fixture adds one `speckit.implement`
confirmation and a separate `workflow.actions` button; it is not a runtime
package or a catalog release.
The Badges tab offers **Value match**, **Artifact current**,
**Artifact stale**, **Checklist progress**, **Checklist complete**,
**Markdown files**, **Work complete**, **Phase run complete**, and **Phase artifact complete**. It starts empty; the new rule does not create default instances. Use
**+ Add badge** to open a separate type picker. The focused editor shows
badge color first, then phase checkboxes with outputs nested under
each selected phase. Selecting a phase starts with its View output; the rule
determines whether one output or several can be selected. Placement offers Workflow list, Workflow summary, and Phase. Each checked
placement has its own editable badge text: Workflow-list text (`text`) and
phase-card text (`phaseText`) accept the rule's per-workflow placeholders;
summary text (`summaryText`) accepts `{workflows}` for the aggregate count
instead of per-workflow placeholders. Phase shows the badge on each selected
evidence phase's card and follows changes to that selection.
Previously saved custom phase/output placements remain visible and are
preserved when edited; select Phase to replace them with evidence-phase cards
or remove the saved placements explicitly. Unavailable saved placements can
be removed without losing valid ones. Only one primary action appears per view:
Add badge on the list, then Create badge or Save changes in the editor.
Configured badges have Edit and Remove actions. Selected evidence outputs stay pinned if their View
default later changes; removing one requires choosing another before Generate.
The same badge type can be added again with different placement text or rule inputs,
even at the same placement. Only the same type, placement texts, inputs, and overlapping
phase/output target (or untargeted badge) are rejected as duplicates by
Save and Generate.
Work complete requires both
checked checklist items and a completed run of a separately chosen phase.
**Markdown files** uses the selected confirmed output as a folder anchor,
counting regular `.md` files in that folder for each workflow, including
when the selected file is absent. Its Workflow summary counts workflows with
at least one matching file (not the total number of files); individual badges
can still show the file count using `{count}`. It does not count checklist items;
**Checklist progress** continues to count Markdown checkboxes.
**Checklist complete** requires a second, earlier confirmed output. It matches
only when the checklist contains at least one item, every item is checked, and
the checklist file is at least as recent as that earlier output. Existing saved
Checklist complete badges must select the earlier output before saving or
generating again; frozen generated apps are not changed automatically.
**Phase artifact complete** checks one target phase and its selected output
against an optional ordered chain of outputs from earlier selected workflow
phases. Each checked prerequisite phase contributes exactly one declared
output, evaluated in workflow phase order; the target is checked last. All
chosen outputs must be regular files, and each later modification time must
be at least the preceding one (equal times pass). A missing output does not
match; unsafe or unavailable metadata produces a diagnostic. Intervening
phases that were not checked are not prerequisites, and no completed phase run
is required. A target-only Specify badge needs no earlier output. When Phase
is checked, the badge appears on the **target** phase card, not on each
prerequisite's card. Workflow list and Workflow summary can be checked
independently, each with its own editable text separate from the phase-card
text. The summary counts matching **workflows**, including zero; it does not
count files or phase runs.
Constitution can provide badge evidence for workflow badges, but its separate
project card and output are not phase-card or phase-output badge destinations.
Summary badges use their configured summary text, interpolating `{workflows}`
with the aggregate count, including zero before any workflows exist. Older
instances without `summaryText` retain the type title plus count; those without
`phaseText` retain their previous phase-card text. Rules contribute one per
matching workflow unless they explicitly supply a numeric summary total.
Renaming a type/default does not overwrite previously saved custom badge text.
**Value match** searches for a required literal string anywhere in one selected
confirmed Markdown output, ignoring capitalization. It does not require a field
label, interpret regex syntax, exclude fenced blocks, or count occurrences.
Enter the whole string (for example, `Verdict: needs-clarification`) if context
matters. Previously saved **Needs clarification** badges are not converted:
the removed type cannot be used in a new Designer configuration. Saved settings
are bound to their original page-model revision, so reopening with changed
templates can require recreating those settings. Already generated apps retain
their frozen rule.

The complete Designer badge list lives in
`designer-host/badges-settings/badge-types.json`. It is one replace-only
Specify template: replace the whole file to add or remove types, rename their
IDs, change picker titles and descriptions, or change default text, color, and
enabled state. Its definitions also supply the selected types in generated
canvases; a type must refer to a registered rule. Rules and their self-contained
JavaScript adapters remain independently replaceable templates under
`generated-host/badges/`; rule metadata declares typed evidence inputs and
supported text placeholders. Each rule's `adapter` names its registered
`generated.badge-rule-adapter` evaluator; this is separate from the Designer
input control's `adapter`. Preset rule definitions using the former `module`
key must change to `adapter` before loading with this source; generated apps
already on disk keep their bundled rule and runtime unchanged. Saved badge
instances refer to type IDs, so renaming
one requires updating existing instances before Generate. Generate
freezes only selected definitions and adapters into the app so runtime never
needs the design-time preset. Generated apps use bounded reads of declared
outputs and recorded runs; rule adapters decide whether evidence matches and
produce badge values and optional nonnegative `summaryCount`. Directory-scoped
artifact evidence counts regular Markdown siblings of the selected output,
without assuming a folder or phase name. Freshness compares artifact modification
time to the latest run's start (or completion for older records without a start).
Counts and freshness are best-effort; unreadable evidence
produces a diagnostic rather than an invented exact result. A replacement
phase adapter must declare badge support before phase-card placement is used.

Designer input controls are separate from generated evaluators. Each registered
`designer.badge-input-binding` maps one rule ID to a reusable
`designer.badge-input-control` JSON definition (`id`, `adapter`, supported
`inputTypes`). Its registered, self-contained `designer.badge-input-adapter`
exports `controlId`, `contractVersion = 1`, and
`mount({root, rule, inputs, phases, outputs, onChange})`. It renders inside the
provided root. The identity and version must be direct literal `export const`
declarations so Designer can check them without executing preset code in Node;
the browser also checks the loaded adapter before mounting it. It reports the
**complete** structured `inputs` object through
`onChange`. The host passes detached snapshots of the rule, inputs, phases,
and confirmed outputs; mutating them does not change host-owned state.
Adapters must send a complete replacement after
initializing defaults and after each edit. Missing or partial callback payloads
are rejected, and a failed adapter import is reported in its badge editor
without preventing other Designer pages from loading. A failing readiness or
validation callback blocks that badge's submission with an inline error; a
failing disposal is reported without blocking navigation. The Designer
validates saved input IDs, types, and confirmed outputs against the rule,
regardless of what the adapter allows in the browser.
The base extension binds its nine rules to `stock.badge-inputs`; a preset can
register a custom JSON definition, adapter, and rule binding without editing
the Badges tab. Add the three named templates to the composed
`load-page` command with strategy `replace`; use the existing Specify template
precedence for replacements. Missing controls or evaluators and disabled types
do not fall back to other implementations. The binding and Designer adapter
are **not** packaged in the generated app. The rule's `before` refers to
another declared input, not to a package dependency.
The generated Workflow page advertises its supported badge destinations
(`workflow.list`, `workflow.summary`, `phase.card`, and `phase.output`) in
`generated-host/workflow-page/workflow.json`. A preset can replace its
registered whole-page adapter and declare a subset; Generate rejects selected
placements outside that subset. The replaceable
phase control declares `phase.card` and `phase.output` in
`generated-host/phase-control/phase-control.json`; its adapter renders the
badge beside the selected phase or individual output link. These names
identify the four supported destinations and are checked at Generate.
The Workflow adapter owns the list, summary, setup, constitution, and phase
composition; the generated host retains authorized actions, persistence,
safe artifact access, and shared application chrome. Declaring another slot
alone does not add a fifth placement choice.

## Requirements

- Specify CLI **>=1.0.7** and an initialized Spec Kit project.
- GitHub Copilot with a separately installed, compatible Canvas Designer
  provider accepting the resolved pages and templates in its open input.
- A launching integration that supplies the Designer handoff.

Installing this extension does not install or open a Designer. The Designer
contract is the `schemaVersion.const` in
`schemas/designer.tab-definition.schema.json` (currently `1`). Bump that
schema version and coordinate with the Designer provider when changing its
supported interface; the extension release version alone does not establish
compatibility.

## Installation

**Recommended: register the catalog once, then install by ID.** Catalogs are
discovery-only by default; `--install-allowed` permits installation:

```powershell
specify extension catalog add https://raw.githubusercontent.com/nicolehaugen/spec-kit-copilot/main/spec-kit-extensions/catalog.json --name spec-kit-copilot --install-allowed
specify extension add extension-canvas-design
```

For a one-off installation without registering the catalog, use the release ZIP:

```powershell
specify extension add extension-canvas-design --from https://github.com/nicolehaugen/spec-kit-copilot/releases/download/extension-canvas-design-v0.1.19/extension-canvas-design.zip
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
in the composed command by presets. One `specify artifact list --json` inventory
supplies each active replace-only template layer's winning path; package tags alone do not register
files. Only after all paths resolve does it open the official Designer provider
once with the complete typed, replace-only set. Missing or ambiguous CLI
resolutions, unsafe paths, missing or unreadable winning files, invalid handoffs,
and an unavailable provider stop the operation before an open URL is returned.
A readable page with invalid JSON shows an error tab with a path and reason;
healthy pages stay usable.

`scripts/verify-launch.mjs` reads the generated skill's declarations and
verifies every declared name against one fresh Specify artifact inventory
before returning the complete pages/templates input. It performs no
installation or provider evaluation. A warning (even on exit status 0),
missing name, invalid or unreadable winning path, ambiguous stack, or executable script collision stops the
open.

The Generate command checks the integrity and checkout binding of its frozen
request, the canvas target, and the Wizard handoff's workflow and installed
inventory before writing files. It includes the hosted Canvas Design selection
when recomputing the handoff fingerprint. If only the source fingerprint
differs, the command returns a warning and attempts generation from the intact
frozen request; the agent reports that warning when opening the generated
canvas. Request or checkout integrity and workflow mismatches still stop it.
The generated `canvas-config.json` records the versions observed in the child
checkout's Specify inventory at Generate; changed versions produce warnings
without blocking. Unavailable package versions are marked `unverified` instead
of being attributed to the Wizard's older inventory.

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
`generated-scaffold/control-contract.mjs` is copied into generated apps;
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
| `generated.workflow-page-definition` | Required generated Workflow page, adapter reference, and supported destinations | [Workflow page](schemas/generated.workflow-page-definition.schema.json) |
| `generated.workflow-page-adapter` | Replaceable whole Workflow-page `.mjs` presentation | Module contract below |
| `generated.field-placement` | Typed field in a declared generated page slot | [field placement](schemas/generated.field-placement.schema.json) |
| `generated.phase-control-definition` | Required phase identity, placement, adapter reference, and optional phase view labels | [phase control](schemas/generated.phase-control-definition.schema.json) |
| `generated.phase-control-adapter` | Workflow phase control `.mjs` presentation | Module contract below |
| `designer.badges-settings-definition` | Complete replaceable badge type list and default appearance, shared by Designer and generated canvases | [badges settings](schemas/designer.badges-settings-definition.schema.json) |
| `generated.badge-rule-definition` | Evidence inputs, badge text placeholders, and evaluator reference | [badge rule](schemas/generated.badge-rule-definition.schema.json) |
| `generated.badge-rule-adapter` | Self-contained `.mjs` evaluator | Module contract below |
| `generated.added-page-definition` | Generated-only page | [generated page](schemas/generated.added-page-definition.schema.json) |
| `generated.added-page-renderer` | Generated-only `.mjs` renderer | Module contract below |
| `shared.control-definition` | Shared typed control | [shared control](schemas/shared.control-definition.schema.json) |
| `designer.control-adapter` | Designer `.mjs` control adapter | Module contract below |
| `generated.control-adapter` | Generated `.mjs` control adapter | Module contract below |
| `generated.value-definition` | Generated constant or computed value | [generated value](schemas/generated.value-definition.schema.json) |
| `generated.computed-value-provider` | Generated `.mjs` provider | Module contract below |
| `generated.dialog-definition` | Named dialog content and decision labels | [dialog](schemas/generated.dialog-definition.schema.json) |
| `generated.dialog-adapter` | Generated `.mjs` dialog presentation | Module contract below |
| `generated.phase-dialog-binding` | Optional per-phase dialog reference | [phase binding](schemas/generated.phase-dialog-binding.schema.json) |
| `generated.button-control-definition` | Named button identity and adapter reference | [button control](schemas/generated.button-control-definition.schema.json) |
| `generated.button-adapter` | Generated `.mjs` button presentation | Module contract below |
| `generated.button-placement` | Setup or workflow button placement and action | [button placement](schemas/generated.button-placement.schema.json) |

Each JSON kind has a matching schema filename. The four required tabs are
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

The required `generated-workflow` page has `schemaVersion: 2`,
`id: "workflow"`, title, order, an `adapter` reference, supported
`badgeDestinations`, and named slots including `workflow.phases`. Its
registered page adapter uses `mount({ root, definition, state, actions })`
and returns `{ update, dispose }`. It renders the Workflow collection,
summary, setup, constitution, details, values, controls, and contribution
slots, composing the independently replaceable phase adapter. The host keeps
shared chrome, navigation to additional pages, persistence, and authorized
actions. Presets may replace both the Workflow page JSON and its adapter,
declare a subset of supported badge destinations, and add slots; unsupported
configured placements fail rather than disappearing. Existing generated apps
with the older page definition keep their original presentation.
The `generated-phase-control` definition places itself in
`workflow.phases`, has `schemaVersion: 1`, `id: "workflow-phases"`, an `adapter` name (stock:
`generated-phase-adapter`), and optional `viewLabels` keyed by selected phase ID,
for example `{ "plan": "View Plan" }`. Unspecified phases retain "View artifact".
The label does not change artifact availability or the host-owned view action.
Both stock and replacement adapters receive `definition` at mount time and must
apply it when the selected phase changes. Designer freezes those definitions,
and the adapter as integrity-checked assets.

Like Designer settings, separately registered generated field placements
target a page and one of its declared slots, identify a field and display
order, and reuse a stock control for scalar fields or a preset control for
object fields. Custom scalar controls are not supported. Added page renderers expose
`data-field-slot` mount points for declared field placements. Several
placements of one field share one value; independent fields can use the
same control adapter. Read-only is the default; an explicitly editable
constant typed value saves through the host's existing `/api/values` endpoint.
Computed values cannot be edited. Stock images are display-only packaged
assets, not runtime uploads. Fixed legacy brand/intro and details bindings
retain their current behavior.

The phase adapter exports `controlId = "workflow-phases"`,
`contractVersion = 1`, and `mount({ root, definition, state, actions })`, returning
`{ update(state), dispose() }`. It owns phase navigation and the selected-phase
card within `root`. `state` supplies the phase list, current index, workflow
identity, status, draft, output, other outputs, and sending status. The host
supplies `actions.select(index)`,
`actions.run(args)`, `actions.view(output?)`, `actions.reveal()`,
`actions.draft(value)`, and `actions.error(error)`. The first four request
host-validated operations; adapters do not call workflow endpoints directly.
The host owns dispatch safeguards, persistence, and artifacts; it never
reaches into the adapter's DOM. An adapter renders its own controls and updates
them in `update` when the host supplies new state.
The generated host displays failures beside the relevant workflow, phase,
dialog, or page rather than in dismissible notifications. When a declared
Markdown output does not exist yet, its link opens the nearest existing
directory inside the checkout instead of showing an empty viewer. This is
host/runtime behavior, not a phase data-contract requirement.
A minimal phase list:

The catalog-listed `copilot-vertical-phase-control` preset replaces the
`generated-phase-adapter` and `generated-phase-control` named templates.
Adapters may export `requiredCapabilities` as an array of unique capability
names; absent means no optional capabilities. For managed runs, the resolved
`generated-phase-control` JSON must additionally declare `"managedRun": true`.
Designer freezes that declaration with the definition's hash; the generated
server never imports the browser adapter to determine its privileges. The
browser rejects unknown requirements before calling `mount`. Currently
supported optional capabilities are:

| Requirement | Additional state and actions |
| --- | --- |
| `workflow.rows.v1` | `state.statuses` maps phase IDs to host-verified status, output, artifact availability and error. `actions.runAt(index)` submits the configured phase with its saved draft; `actions.viewAt(index)` opens its authorized artifact. Invalid indexes and unavailable artifacts fail visibly. |
| `workflow.managed-run.v1` | `state.autopilot` contains the session's persisted run status, target workflow ID, current step and progress message (or `null`). `actions.startManagedRun()` preflights and starts the attached Copilot session's ordered workflow; `actions.stopManagedRun()` cancels it from any open panel. Failures are reported through `actions.error` or the host's canvas message. The runtime verifies the packaged adapter's hash and the capability frozen from its phase-control definition before starting a run. |

These actions are stable host operations, not preset-specific buttons. The
vertical adapter owns its entire layout, row selection and confirmation flow;
it does not call `/api` or the Copilot session directly. The host continues to
enforce conflicts, step order, artifact/path checks, cancellation, and
persistence even if the adapter omits a UI safeguard. Adding another adapter
that uses these capabilities needs no new host branch. A genuinely new
privileged operation requires a deliberate, versioned host capability rather
than an adapter reaching into private host code. The stock adapter declares
no optional capabilities, so its behavior remains unchanged. See the
[preset guide](../../spec-kit-presets/copilot-vertical-phase-control/README.md)
for local installation; the catalog download requires a published release.

```js
export const controlId = "workflow-phases";
export const contractVersion = 1;
export function mount({ root, definition, state, actions }) {
  const list = document.createElement("ol");
  root.replaceChildren(list);
  const update = ({ phases, current }) => {
    list.replaceChildren(...phases.map((phase, index) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = phase.label;
      button.setAttribute("aria-current", current === index ? "step" : "false");
      button.onclick = () => Promise.resolve(actions.select(index)).catch(actions.error);
      item.append(button);
      return item;
    }));
  };
  update(state);
  return { update, dispose() { root.replaceChildren(); } };
}
```

The snippet illustrates the lifecycle only; a working replacement also renders
the phase card and actions. See
[`generated-phase-adapter`](generated-host/phase-control/generated-phase-adapter.mjs)
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

Save can retain unfinished work. The browser checks `isReady()` before Save or
Generate across visited tabs, but always allows switching tabs so a broken
control cannot trap the user. Returning to a tab retains its control state so
an unfinished upload can be retried or cancelled.
The server invokes the approved adapter's
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
