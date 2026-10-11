---
name: dev-tools-speckit-distribution
description: 'Prepare fork/upstream distribution metadata, explicitly release selected components, or verify published installs. USE FOR: repository-maintainer marketplace/catalog preparation and authorized release orchestration. DO NOT USE FOR: ordinary runtime settings, automatic publication, development version bumps, or replacing Specify consumer skills.'
argument-hint: '[prepare|release|verify-install] [upstream|fork|custom JSON]'
---

# Spec Kit distribution

Repository-maintainer skill, not a shipping core CLI skill. Defaults to **prepare**;
never infer release authorization from a development edit or preparation request.
No automatic workflow mutation or second packaging pipeline.

## Prepare (no publishing side effects)

1. Record current worktree status; identify target repository/ref. Select
   `config\distribution.upstream.example.json`,
   `config\distribution.fork.example.json`, or an explicitly supplied custom
   JSON. Examples are choices, not inferred from the branch.
2. Run `node dev-tools\prepare-distribution.mjs --config "<JSON path>"`.
   Show its actual affected-file diff, locators, and printed install commands.
   Only with explicit approval repeat with `--apply --expect "<preview digest>"`.
   Preserve sibling dated backups. Re-preview conflicts; never force overwrite.
   The helper preserves IDs, versions, requirements, custom/unrelated metadata
   and catalog entries, deriving only Canvas Design and vertical-control links
   plus catalog self URLs and marketplace display metadata. It refuses
   manifest/catalog version conflicts; reconcile only through an authorized edit.
3. Review Git diff and validate the selected manifests/catalogs. Update related
   documentation manually if authorized. Print commands, do not execute them
   as part of prepare. Preparation does not make remote metadata available and
   does not change runtime settings, commit, push, tag, publish, or bump versions.

## Release (explicit authorization required)

1. Confirm repository, release commit/ref, components, versions, and publication
   authorization. Separate authorization for commit/push from publication.
   Update only selected component versions and matching manifest/catalog/docs.
   Follow existing marketplace metadata version rules only when releasing.
2. Prepare aligned metadata as above, run focused package/contract tests and
   target URL validation. Inspect existing extension and preset trigger/publisher
   workflows; reuse them unchanged except separately approved fixes.
   `GITHUB_REPOSITORY` controls publisher download URLs. Ensure prepared metadata
   matches the repository actually executing the workflows. Never relocate or
   release unrelated upstream catalog entries just to make fork checks pass.
3. Commit/push only when authorized. Publish from the prepared release commit/ref
   using existing **Release Extension Trigger** (`extension-canvas-design`,
   exact version) and **Release Preset Trigger** (`copilot-vertical-phase-control`,
   exact version), only for selected changed components. Review trigger inputs,
   use `gh workflow run ... --repo <owner/repo> --ref <release ref>`, then inspect
   workflow completion, tags and ZIP assets. Never move tags or replace a ZIP.
4. Publishing an asset does not update hosted catalogs. Do not expose catalogs
   pointing at missing assets: stage the prepared release commit/ref, publish
   selected assets, then promote the intended catalog/marketplace ref with
   authorization. Fetch served metadata and verify exact versioned assets before
   announcing availability. Do not alter workflows automatically.

## Verify-install (published path, no local overrides)

1. Confirm target marketplace/catalogs and clean test project. Use printed
   matching marketplace commands; install Wizard and required core skills.
   Reuse `speckit-cli-setup`, `speckit-extension`, and `speckit-preset` for
   Specify consumer operations; do not rewrite those skills as publishers.
   Catalogs need `--install-allowed` to permit installation; reconcile existing
   registrations explicitly rather than blindly adding duplicates.
2. Configure corresponding runtime settings explicitly with preview/confirmation
   using `node dev-tools\configure-runtime.mjs`; require its matching preview
   digest before apply and retain backups. Installation/enabling alone does not
   activate the providers. Do **not** use installed-refresh to verify a published path.
3. **Required install step: activate both installed providers.** Read
   `.github\skills\dev-tools-speckit-wizard-installed-open\references\provider-state.md`
   and execute its complete **Activation** procedure without opening a canvas.
   Inspect both exact IDs and match their common installed root and provenance
   to the intended installation. Back up settings and remove only their two
   exact IDs from `extensions.disabledExtensions`, preserving all other entries.
   Use the reference's `node dev-tools\clear-provider-disables.mjs` preview and
   confirmed digest/apply procedure, not a manual settings edit.
   Reload and require both running; clear persisted settings with live disabled
   state requires a new session/restart and stops this install journey.
4. **Require Designer reload-skills availability before launch.** Discover the
   callable `speckit_designer_reload_skills` tool; stop if unavailable. Only after
   activation and tool discovery may an explicitly requested Wizard-to-Designer
   journey proceed. Use `dev-tools-speckit-wizard-installed-open` to open Wizard,
   forwarding an explicit Generate request only when requested. Require the
   tool again in the actual Designer child before setup and require success at
   its post-install reload step. Do not invoke it prematurely, assume child
   inheritance, or substitute plain-text `/skills reload`.
5. Use no local-source overrides. Retrieve the **published archives selected by
   the catalogs**, compare actual versions/content/contracts, and verify child
   Canvas Design and vertical-control installations, resolved contributions,
   Designer and generated output. Report unavailable/incompatible hosted packages
   as release-readiness concerns, never as local-source success.

Leave personal skills untouched; use `/skills reload` to discover this project skill.
