# Unverified claims register

Everything below came from research, **not** from a primary source checked in this
repo. Nothing here may become seed data, a constant, or a user-facing statement
until it is verified and the row is updated with a date and a citation.

Tax rates, schedule policy and entitlements are **data**, not code: a rate change
is a seed row plus a `notification_ref`, never a deploy.

| Claim | Why it matters | Status |
|---|---|---|
| Current GST slab list and the notification that set it | Drives `seed/tax_rates`. A wrong rate is a wrong bill and a wrong return. | **unverified** — check CBIC notification text directly |
| Which HSN codes (3003/3004/3005/3822…) sit in which slab | Same | **unverified** |
| Count of nil-rated life-saving drugs (research contradicted itself) | Seed data | **unverified** |
| e-invoicing turnover threshold and the IRP upload window | Gates a whole post-MVP module | **unverified** |
| B2C dynamic-QR turnover threshold | Gates a Phase-2 feature flag | **unverified** |
| Composition-scheme rate and turnover ceiling | Changes the document type to a Bill of Supply | **unverified** — out of scope (regular scheme chosen) |
| Rule 46 recipient-details value threshold | Changes B2B invoice validation | **unverified** |
| Schedule H1 register retention period | Drives `retention_policies` | **unverified** |
| Schedule X prescription retention period | Same | **unverified** |
| GST record retention period | Same | **unverified** |
| Companies Act record retention period | Same (longest-wins) | **unverified** |
| The Schedule H1 substance list and its length | Blocking capture at billing | **unverified** — must come from the gazette |
| DPDP Rules phasing dates and penalty schedule | Sequences the consent/DSAR work | **unverified** |
| Thermal column count: 42 vs 48 at 80mm | Guessing wrong truncates **every** receipt | **unverified** — needs the pilot store's printer model |
| Whether the pilot store's scanner is a 2D imager | A 1D laser cannot read DataMatrix/QR at all | **unverified** — needs the model number |

## Trade conventions — configuration, never constants

These are secondary-source commercial norms, not statute. Each is a per-store or
per-supplier column with a seeded default, so a store that works differently is a
data change:

- retailer / stockist margin bands → `suppliers.*`, reporting defaults
- breakage allowance on expiry claims → `suppliers.breakage_allowance_pct`
- supplier expiry-return window → `suppliers.return_window_days`
- near-expiry bucket boundaries → `stores.near_expiry_buckets`
- expired-stock disposal timelines (state-specific) → store policy
