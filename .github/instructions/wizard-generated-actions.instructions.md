---
applyTo: "plugins/spec-kit-copilot-wizard/extensions/speckit-wizard-canvas/**/*,plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/**/*,spec-kit-extensions/extension-canvas-design/generated-host/**/*,spec-kit-extensions/extension-canvas-design/templates/generated-canvas/**/*,spec-kit-presets/*/generated/**/*"
---

Keep phase Run and retry actions available when a Copilot agent turn is
`Request sent`, `Running`, or otherwise awaiting a response. An agent turn may
never report completion, so do not disable or hide these actions solely until
the turn completes. Show the current status and, when a repeat dispatch could
duplicate work, explain that risk and let the user deliberately choose whether
to retry. An in-flight submission guard must not depend on an agent response to
release it; provide a bounded recovery path after errors, timeouts, or refresh.

When changing pending-action behavior, cover the case where the agent never
responds and verify that the user can still initiate a retry.
