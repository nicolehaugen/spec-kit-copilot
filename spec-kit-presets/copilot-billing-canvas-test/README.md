# Billing Canvas Design test preset

This repository-local fixture is not in the published preset catalog. It appends
the Billing page and cost-code contribution names to the composed `load-page`
command. Both files must be explicitly resolved; an unregistered page file
does not create a Designer tab.

The contribution targets `billing.options` by default. To place the **same**
`billing.costCode` field on Essentials instead, override the named
`canvas-contributions-billing` template with `"slot": "essentials.options"` and
keep the Billing page registered (it will have no fields). Only one placement
may be registered at a time. Both slots accept ordered fields; the field ID,
64-character bound, save/reopen behavior, and generated read-only value remain
identical. No stock adapter JavaScript is needed: `stock.text` and
`stock.readonly` select built-in renderers.
