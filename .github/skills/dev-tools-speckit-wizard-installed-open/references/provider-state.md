# Installed Wizard/Designer provider state

Shared guidance for installed-open, distribution, and clean-reset. Read this file
before executing its procedures. These procedures never open a canvas, launch
Designer, refresh provider code, or change runtime catalog/Generate settings.

The only owned provider IDs are:

- `plugin:spec-kit-copilot-wizard:speckit-wizard-canvas`
- `plugin:spec-kit-copilot-wizard:speckit-canvas-designer`

## Activation (required after install/enable, before canvas use)

1. **Inspect both providers before any settings edit.** Use `extensions_manage`
   inspect on each exact ID above. Require `Source: plugin` and the respective
   `extensions\speckit-wizard-canvas\extension.mjs` and
   `extensions\speckit-canvas-designer\extension.mjs` paths beneath the same
   installed plugin root. Derive the root from inspection, never guessed paths.
   Check its `plugin.json` name is `spec-kit-copilot-wizard`; match its version,
   root and installation provenance against `copilot plugin list --json` and
   the intended marketplace/repository/ref. Neither this worktree nor a
   personal/session extension is an installed substitute. Stop on missing,
   ambiguous, mismatched or incompatible providers. Never enable unknown IDs.
2. **Clear exact persistent disable entries.** Execute the subsection below,
   including backup and re-read, even when inspection already says running.
   If the confirmed plugin itself is disabled, enable only its resolved
   installation with `copilot plugin enable <exact-plugin-identifier>`; use a
   marketplace-qualified identifier where supported and needed. Stop if the
   available command cannot unambiguously select that installation.
3. **Reload and require both running.** Call `extensions_reload` even if no
   settings edit was needed. Inspect both exact IDs again and recheck their
   common root/provenance. Require both statuses to be running. On failed or
   disabled providers, report status and startup logs from `extensions_manage`
   inspect, keeping credentials and loopback tokens private.
   If persisted settings are clear but live state remains disabled, stop and
   require a new session/restart; do not retry a canvas launch or claim readiness.
4. **Require the Designer tool before launch.** Discover
   `speckit_designer_reload_skills` with the tool resource listing/search and
   require its callable schema to be available. Discovery is not invocation:
   do not reload skills prematurely just to test availability. If absent, stop
   and report the missing tool. Wizard opening alone is not Designer readiness.
   Check availability again in the actual Designer child before its setup;
   the child must require success from its existing post-install reload step,
   never substitute plain-text `/skills reload` or assume tool inheritance.

## Clear exact persistent disable entries (also used by clean-reset)

This subsection does not enable or reload providers. Activation requires the
inspection above first. Clean-reset instead uses its confirmed target inventory;
providers may already be absent after uninstall. Their absence does not justify
skipping stale disable entries or changing the two allowed IDs.

1. Preview `node dev-tools\clear-provider-disables.mjs` from the current
   worktree. It selects `~\.copilot\settings.json`; `--file "<absolute path>"`
   is only for an explicitly identified alternate Copilot settings file.
   The script validates JSON and the disable-list shape, rejects duplicate JSON
   fields and symlink/junction paths, and leaves absent files/properties absent.
   Show its actual diff and the two fixed provider IDs. Obtain confirmation
   before apply; clean-reset's exact-target confirmation covers this diff.
2. Apply the same command with `--apply --expect "<preview digest>"`.
   The script backs up original bytes to an exclusive dated sibling file before
   writing, removes **only these two exact IDs** (including duplicates), and
   preserves unrelated settings, disabled entries, similarly named IDs and
   their order. It rejects stale previews instead of overwriting concurrent
   edits. Retain all returned backup paths. Re-preview conflicts and obtain
   fresh confirmation; never fall back to a manual edit or broader removal.
3. The script re-reads persisted settings and verifies the exact expected bytes.
   Stop on backup, write, locked-file, conflict or verification failure; report
   incomplete state and retained backups. A script success verifies persisted
   settings only: it does not enable the plugin, reload providers, confirm live
   running state, discover the Designer tool or open a canvas. Continue the
   caller's explicit live-state checks; never treat script success as readiness.
