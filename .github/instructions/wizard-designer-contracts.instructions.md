---
applyTo: "plugins/spec-kit-copilot-wizard/extensions/speckit-wizard-canvas/**/*,plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/**/*,spec-kit-extensions/extension-canvas-design/**/*,spec-kit-extensions/tests/**/*,spec-kit-presets/*/generated/**/*,spec-kit-presets/copilot-wizard-layer-test/**/*,tests/e2e/**/*,tests/fixtures/specify/**/*"
---

Do not change a Wizard, Designer, or generated-canvas data contract without
explicit instruction from the user to make that contract change. This includes
schemas and validation rules, persisted state and handoff formats, canvas action
inputs and outputs, HTTP/SSE payloads, artifact and phase reporting shapes, and
test fixtures that define those interfaces. A request to fix a bug, make tests
pass, or implement a UI change is not approval to change a contract.

If a contract change appears necessary, explain the existing contract, the
proposed change, and its compatibility and test implications, then ask the user
for approval before editing it. Until approved, preserve the contract and
investigate a compatible implementation instead.
