---
name: dev-tools-import-generated-canvas
description: 'Import a Designer-generated canvas into an existing or new repository plugin and remove checkout-specific setup references. USE FOR: development-only canvas promotion, clean replacement of a plugin canvas, and packaging a generated canvas as a new plugin. DO NOT USE FOR: generating canvases, refreshing generator changes in another session, installing providers, or publishing releases.'
argument-hint: '<generated canvas directory> [plugins\<plugin>\extensions\<canvas>] [replace existing|new plugin]'
---

# Import a generated canvas into a development plugin

Work only in the current repository worktree. This skill **copies** a generated
canvas into `plugins\<plugin>\extensions\<canvas>`; it does not delete the source,
install packages, refresh installed providers, run workflow phases, or publish.
Do not invoke `create-canvas`, regenerate over an existing app, change generator
templates, or modify the main checkout. Do not execute this workflow merely
because the user asks to create or edit this skill.

## Resolve the source and destination

1. Read `AGENTS.md` and applicable repository instructions. Record
   `git status --short`. Resolve the user-supplied source directory read-only,
   including when it is in another worktree. Do not search unrelated checkouts
   or choose the newest Designer session implicitly. If no source is supplied,
   ask for it.
2. Verify an actual generated app: inspect `canvas-config.json`, `extension.mjs`,
   its imported host modules, UI/assets, contracts, `canvas-setup.json`, and
   `settings-provenance.json` when present. A Designer handoff or an installed
   `.specify\extensions\extension-canvas-design` package is not the generated app.
   Record the canvas ID, phases, artifact paths, package recipe, dependencies,
   required files, and adapter/definition hashes. Do not assume every generation
   has the latest generator's file layout or supported setup package kinds.
3. Inventory `plugins` and their `plugin.json` files. Resolve whether the user
   wants to replace a canvas in an existing plugin, add a canvas to an existing
   plugin, or create a new plugin. Reuse an existing identity only when it is
   unambiguous and matches the request. Otherwise ask for the destination and
   plugin identity before writing. A plugin may contain multiple extensions;
   never treat one canvas replacement as replacing its whole plugin.
4. Require the destination to be inside the current worktree's `plugins` tree,
   distinct from and neither ancestor nor descendant of the source. Check both
   trees and their ancestors for symlinks/junctions and path escapes before
   reading/copying recursively. Reject unsafe paths.

**An existing destination canvas directory is always totally overwritten.**
Its final contents must exactly match the reviewed import: every file is
replaced, and every destination file absent from the import is deleted,
including old implementation files and earlier customizations. Back them up
first (see below); do not ask to keep them. The overwrite is confined to that
one canvas directory. Files outside it, such as `plugin.json`, other canvases,
skills, and tests, are preserved.

## Plan the clean import

Compare source/destination file inventories and hashes. Report the exact target,
files to be overwritten, added, and deleted, and the checkout-specific
references to reset.

Carry the complete generated runtime, contracts, definitions, adapters, UI,
assets, and required dependency manifests together. Inspect imports and asset
references rather than hard-coding the Bug Fix canvas's filenames. Retain the
source's license and attribution. Exclude `.git`, `node_modules`, caches, logs,
test output, credentials, generated run history, receipts, and workflow artifacts.
Do not copy the source checkout's `.specify` tree, installed skills, or session
workspace. The generated app's own source files are not disposable runtime state.

**Clean does not mean remove every `.specify` reference.** Preserve relative
workflow paths, for example `.specify/bugs/<slug>/assessment.md`, package IDs,
selected phases, badges, branding, enabled state, priority, and versions.
Do not silently correct unrelated badge behavior or upgrade Specify.

Inspect configuration, setup values, provenance, documentation, and executable
code for absolute paths, `file:` URLs, source checkout/session bindings, and
embedded machine-specific data. Handle each according to its meaning:

- Replace local package locators only with a **verified, user-approved portable
  locator** for the same package and frozen version. Read the actual catalog
  entry/package manifest; names alone are not evidence of equivalence. Preserve
  `installedId` versus `catalogId` and the selected catalog's exact download URL.
  A default-source null URL is valid only where the existing contract permits it.
  Remove a local locator's `path` only when replacing the whole locator with the
  valid portable shape; keep matching setup snapshots consistent.
- If no equivalent portable source exists, stop and ask for an approved source
  or a decision on that dependency. Do not infer a hosted URL, drop the package,
  add transitive packages, change its version, or leave a local-only recipe while
  claiming the import is portable. Include bundles only if this app's setup
  contract supports them; do not strip an unsupported package kind silently.
- Keep runtime checkout resolution dynamic through the generated host's
  existing session metadata. Never bind it to the import source or destination.
  Reset copied run state and approval/install receipts by excluding them, not
  by changing runtime state schemas or fabricating an initialized project.
- Preserve valid `canvas-setup.json` settings and provenance structure.
  Non-path request IDs/fingerprints can remain historical generation metadata;
  they are not current installation receipts. Do not invent new fingerprints
  or claim that sanitized settings still reproduce the original generation.
  If required provenance cannot remain valid without a contract change, stop.

Do not change existing host-adapter contracts, validation, actions, persisted
state shapes, or payloads without explicit user approval. Follow
`.github\instructions\wizard-designer-contracts.instructions.md`; explain old
versus proposed behavior and compatibility/test impact before requesting it.
Keep registered JSON definitions and adapter/renderer pairs together. Do not
patch checked adapter bytes or recompute hashes to bypass incompatibilities.

## Apply to the plugin

1. Back up files that will be overwritten or removed to a named directory under
   this session's `files` area outside the repository. Stage the reviewed copy
   there first and apply only the agreed cleanup. Keep the source untouched.
2. For an existing canvas, back up the entire destination canvas directory, then
   overwrite every file and delete every destination file and empty directory
   not in the reviewed import, so nothing from the old implementation remains.
   Delete files individually from the computed inventory, only inside that
   canvas directory; never mirror/delete the plugin directory. The only
   additions beyond the generated source are packaging files the plugin needs
   for discovery (for example, `copilot-extension.json`) and the canvas README,
   regenerated from the new canvas rather than carried over from the old one.
   Verify the final inventory exactly matches the planned one.
3. For a new plugin, follow neighboring plugin manifest conventions: create
   `plugins\<plugin>\plugin.json`, an `extensions` entry pointing at its extension
   directory, and a README. Use the confirmed plugin identity and an initial
   development version consistent with repository conventions. Do not fabricate
   author/repository/license values; reuse only verified repository metadata.
   Preserve or add `copilot-extension.json` only according to the host's current
   discovery requirements and existing repository examples. Keep its identity
   consistent with the canvas and do not confuse its schema version with semver.
4. Preserve canvas IDs when replacing the same canvas. If the intended ID differs,
   inspect all registrations/configuration/manifests and obtain approval for any
   contract change before renaming. Do not create two active providers with
   indistinguishable identities as part of this import.
5. Update the canvas/plugin README and relevant root documentation with local
   loading instructions, workflow artifact locations, setup requirements, and
   any known compatibility limits. Keep release/catalog metadata unchanged:
   no marketplace entry, catalog URL edit, existing version bump, tag, release,
   commit, or push unless separately requested. A new plugin can remain local.

## Verify the imported copy

- Parse manifests and configuration and run the imported host's actual config,
  setup, and contribution validators. Verify all referenced modules/assets exist
  and checked hashes still match. Run `node --check` on imported JS/MJS entry
  points and affected modules where supported by their module format.
- Preserve the exact bytes of hash-checked contributions in Git and archives
  across platforms. Compare filtered and unfiltered Git blob hashes with
  `core.autocrlf=true`; if needed, add narrowly scoped `.gitattributes` `-text`
  rules without changing the contributions or their frozen hashes.
- Run the smallest existing relevant tests. Add focused plugin tests for the
  imported configuration's portability and supported host-adapter exchanges,
  including valid and incompatible inputs; use existing plugin tests as patterns,
  not Bug Fix-specific assumptions. Test setup planning without installing real
  packages. Stop visibly on missing dependencies or validation failures; restoring
  dependencies requires the usual missing-dependency/manifest-change justification.
- Scan the destination for the known source checkout path, local package locators,
  session bindings, secrets, and copied execution state. Inspect matches rather
  than deleting all `.specify` strings. Verify relative artifact templates and
  package identity/version/settings survived. Compare final status with the
  original inventory and ensure files outside the agreed scope were preserved.
- If local loading was requested, inspect supported `copilot --plugin-dir` usage
  or the actual extension provider tooling and load this exact plugin. Reload
  only an explicitly authorized test provider. Verify registration and opening;
  do not initialize the checkout, install runtime packages, submit setup, or run
  phases just to prove the shell opens. Clean up only helpers started for this check.

Report the destination, whether it replaced or created a plugin/canvas, sanitized
references, retained workflow paths, and actionable blockers. Distinguish
worktree checks, installed-provider checks, and published hosted readiness.
An unresolved frozen-package incompatibility is a release-readiness concern,
not permission to bump versions or publish. Source removal or installed-provider
refresh requires a separate explicit request. Use `/skills reload` when the user
needs to discover a newly added project skill.
