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
| Rule 46 recipient-details value threshold | Raises a WARNING on an unnamed high-value counter bill | **unverified, and now held as CONFIGURATION** — `StoreProfile.filing.rule46Minimum`. Warning only, never a blocker: a shop holding the details on paper is not in breach because RxBill cannot see them. |
| Schedule H1 register retention period | Drives `retention_policies` | **unverified** |
| Schedule X prescription retention period | Same | **unverified** |
| The statutory FORM for a Schedule X running-balance register — its number, its exact columns, and whether a bound physical register is required alongside a printed one | Would decide the layout of the controlled-drug register | **unverified, and the report says so on its face.** `CONTROLLED_BALANCE` prints the shop's own movement record as a running balance reconciled to the shelf, and its notes state plainly that it is not a rendering of a statutory form. No form number is printed anywhere. Telling a pharmacist they are compliant on the strength of a guess is worse than telling them nothing. |
| GST record retention period | Same | **unverified** |
| Companies Act record retention period | Same (longest-wins) | **unverified** |
| The Schedule H1 substance list and its length | Blocking capture at billing | **unverified** — must come from the gazette |
| DPDP Rules phasing dates and penalty schedule | Sequences the consent/DSAR work | **unverified** |
| Thermal column count: 42 vs 48 at 80mm | Guessing wrong truncates **every** receipt | **unverified** — needs the pilot store's printer model |
| Whether the pilot store's scanner is a 2D imager | A 1D laser cannot read DataMatrix/QR at all | **unverified** — needs the model number |
| GSTN unit-quantity codes (NOS / MLT / GMS / BTL / VLS / TUB) | The HSN summary export carries a UQC per row; a wrong code is a rejected Table 12 | **unverified** — take the list from the GSTN UQC master, not from a blog. The Reports screen labels the column as unverified and derives it from `medicines.base_uom` |
| HSN digit length required in GSTR-1 Table 12 (4 vs 6, by annual turnover) | Decides whether the HSN summary may be filed as-is | **unverified, and now held as CONFIGURATION** — `StoreProfile.filing.hsnDigits`. RxBill holds no turnover figure, pads nothing and truncates nothing; a shorter HSN is a warning naming the configured length. |
| B2CL / B2CS invoice-value threshold (₹1,00,000 vs ₹2,50,000 — sources conflict) | Buckets an invoice in the filing-readiness check | **unverified, and now held as CONFIGURATION** — `StoreProfile.filing.b2clMinimum`, defaulting to the higher figure. The check prints the figure it used and says the sources disagree; nothing is filed on it. Shipping the lower default would mark invoices B2CL that may not be, which reads as RxBill knowing something it does not. |
| GSTR-1 / GSTR-3B due dates and QRMP cadence | Would gate any in-app filing reminder | **unverified** — no due date is stated anywhere in the UI until it is |
| Current state of GSTR-1 Table 12 phasing (B2B/B2C tabs, manual-entry lock) | Shapes the HSN summary | **partly verified** — the B2B/B2C split is implemented; the phase roadmap beyond it is not asserted in the UI |

## Trade conventions — configuration, never constants

These are secondary-source commercial norms, not statute. Each is a per-store or
per-supplier column with a seeded default, so a store that works differently is a
data change:

- retailer / stockist margin bands → `suppliers.*`, reporting defaults
- breakage allowance on expiry claims → `suppliers.breakage_allowance_pct`
- supplier expiry-return window → `suppliers.return_window_days`
- near-expiry bucket boundaries → `stores.near_expiry_buckets`
- expired-stock disposal timelines (state-specific) → store policy

## What the filing-readiness check does and does not claim

Added with the GST filing wave. The check reports whether a period would be
**rejected**, which is a narrower and much more answerable question than whether
a return is **correct**:

- It asserts no law. Every threshold arrives from `StoreProfile.filing`, every
  one is listed above, and the figure actually applied is printed in the result's
  `basis` beside the reason it is uncertain.
- It generates no GSTR-1 JSON and files nothing.
- A **blocker** is something the portal will reject on format — an invoice that
  does not foot, a malformed GSTIN, a line with no HSN. A **warning** is a
  judgement a human has to make. Reporting the second as the first is how a
  compliance screen gets ignored, and once it is ignored the blockers go with it.
