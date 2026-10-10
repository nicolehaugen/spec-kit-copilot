---
name: dev-tools-speckit-clean-reset
description: 'Preview and remove approved installed Spec Kit Wizard/Designer and core plugins, their unused marketplaces, and runtime overrides. USE FOR: confirmation-gated maintainer clean reset and exact provider-disable cleanup. DO NOT USE FOR: reinstalling, publishing, deleting projects/source folders, or removing unrelated plugins or personal skills.'
argument-hint: '[approved plugin installations] [marketplaces] [runtime settings paths]'
---

# Clean reset of installed Spec Kit integrations

Repository-maintainer cleanup only. Wizard and Designer belong to the single
`spec-kit-copilot-wizard` plugin; core is `spec-kit-copilot`. Do not treat Designer
as a separate plugin or expand cleanup to every `spec-kit-*` name.
Stop after cleanup. Installing a released version is a separate, explicitly
requested `dev-tools-speckit-distribution` action.

1. **Inventory exact targets (read-only).** Run `copilot plugin list --json` and
   `copilot plugin marketplace list`; check available command help. Resolve
   each intended installed Wizard/core plugin's exact identifier, version,
   installation root, source repository/ref and marketplace, if any.
   Inspect the two exact Wizard/Designer providers using `extensions_manage`.
   When present, require plugin source, corresponding entry paths and a common
   root matching the intended Wizard installation and its `plugin.json`.
   Missing providers are allowed during uninstall inventory, but do not guess
   ambiguous provenance. External `--plugin-dir`, user/session providers or
   duplicate identities are blockers, not permission to delete source folders.
   Read
   `.github\skills\dev-tools-speckit-wizard-installed-open\references\provider-state.md`;
   retain the confirmed inventory for its **Clear exact persistent disable
   entries** subsection even after uninstall. The only disable-list targets are
   `plugin:spec-kit-copilot-wizard:speckit-wizard-canvas` and
   `plugin:spec-kit-copilot-wizard:speckit-canvas-designer`.
2. **Preview exact cleanup and blockers.** Show exact uninstall identifiers,
   roots/provenance, marketplace names and all installed dependents. A shared
   marketplace with any plugin outside approved Wizard/core targets is a blocker:
   preserve it and its dependents; do not describe the requested reset as complete.
   Inspect `~\.copilot\settings.json` and preview removal of only the two exact
   IDs from `extensions.disabledExtensions`, preserving all other entries.
   Use `node dev-tools\clear-provider-disables.mjs` to obtain the exact diff
   and its apply digest; do not implement the JSON removal manually.
   Run `node dev-tools\configure-runtime.mjs show`; identify the optional default
   runtime file and any explicit `SPECKIT_CONFIG_FILE` destination. Preview each
   only after proving it is an owned runtime override, not a source file,
   project artifact, personal skill, or backup. An explicit selector alone is
   not permission to overwrite a protected file; report that target as a blocker.
   Preview each
   approved destination with
   `node dev-tools\configure-runtime.mjs use-defaults --file "<absolute path>"`.
   Do not create absent optional files just to reset them. Show actual diffs,
   effective defaults and preview digests. A selector can remain pointing at a
   reset `{}` file; never delete an explicitly selected file.
   Include backup destinations and a preservation list: unrelated plugins,
   personal skills, existing projects and their Specify packages/catalog
   registrations, source folders, unrelated settings, and existing backups.
   Stop before mutation on ambiguous targets, shared marketplaces, malformed
   settings, unsupported tools or locked files; report concrete blockers.
3. **Require explicit confirmation before mutation.** Ask the user to approve
   the exact plugins, unused marketplace registrations, runtime destinations
   and disable-list diff. A general reset request is not approval of guessed
   targets. Recheck inventories and original settings before applying; changed
   targets/content require a fresh preview and confirmation. If a target is
   already absent, record it as absent rather than invent a replacement target.
4. **Back up and clear exact disable entries.** Execute only **Clear exact
   persistent disable entries** from the shared reference, with its backup,
   scripted exact-ID removal and re-read checks. Apply
   `node dev-tools\clear-provider-disables.mjs --apply --expect "<confirmed preview digest>"`;
   retain the script's dated sibling settings backups. Preserve every unrelated value.
   Do not execute Activation, enable providers, open a canvas or launch Designer
   during cleanup. Backup/write/conflict failures stop cleanup.
5. **Uninstall approved plugins with existing tools.** Run
   `copilot plugin uninstall <exact-plugin-identifier>` separately for each
   approved installation. Prefer `plugin-name@marketplace-name` for marketplace
   installs; use an unqualified name only when inventory proves it unambiguous.
   Do not manually delete plugin/cache directories, use wildcards, or remove
   personal skills. Stop on command failures or locked files and report partial
   cleanup plus retained backups; do not claim success or force deletion.
6. **Reset approved runtime overrides with the existing helper.** Repeat each
   confirmed `use-defaults --file "<absolute path>"` command with
   `--apply --expect "<that preview digest>"`. Retain its dated sibling backups.
   This writes `{}` and preserves an explicit `SPECKIT_CONFIG_FILE` selector;
   do not edit machine-wide environment settings or source example files.
   Re-preview conflicts and obtain fresh confirmation; do not force overwrite.
   Stop on configuration errors and report incomplete cleanup.
7. **Remove only approved unused marketplaces.** Refresh plugin inventory and
   require no remaining installed dependents before
   `copilot plugin marketplace remove <exact-name>`. Never use `--force` or `-f`:
   forced removal can uninstall unrelated plugins. A shared marketplace or
   failed removal remains a blocker; preserve it and report partial cleanup.
8. **Verify cleanup, then stop.** Call `extensions_reload`; re-list plugins and
   marketplaces and require approved targets absent. Inspect/list providers and
   require both exact IDs absent, not merely disabled. Re-read settings and
   require both exact disable entries absent with unrelated entries unchanged;
   verify approved runtime files contain `{}` and configuration `show` resolves
   packaged defaults. Compare retained plugin/marketplace inventories and
   unrelated settings with the preview. Missing evidence is not success.
   Stale providers after uninstall/reload require a new session/restart and
   verification there; report cleanup incomplete until that is established.
   Report removed/already-absent targets, retained resources/backups and any
   blockers. Do not install, update, register replacement marketplaces, invoke
   distribution automatically, or claim a future released installation works.

Leave personal skills untouched; use `/skills reload` to discover project changes.
