import type {
  AuditAction, AuditChange, AuditEntry, Customer, Doctor, Money, OverrideReason, StoreProfile,
  Supplier, User,
} from '@contract'
import type { TaxRateRow } from './schema'

/**
 * Reference data that is NOT the medicine master.
 *
 * The tax rates below deliberately model a mid-life slab change so the
 * resolve-by-invoice-date path is exercised from day one: stock received under
 * the old rate must SELL at whatever rate is in force on the day of sale, and a
 * credit note against an old sale must reverse at the ORIGINAL rate. A design
 * that hangs the rate off the product cannot express any of that.
 *
 * These figures are DEMO values. Nothing here is a citation — see
 * docs/UNVERIFIED.md, which tracks every threshold that must be confirmed against
 * a primary source before this is used for real billing.
 */

export const DEMO_STORE: StoreProfile = {
  id: 1,
  name: 'Sanjeevani Medical Store',
  tagline: 'Your neighbourhood pharmacy since 1998',
  addressLine: '12, Shivaji Market, MG Road',
  city: 'Pune',
  state: 'Maharashtra',
  stateCode: '27',
  phone: '+91 98220 41100',
  email: 'care@sanjeevanimeds.in',
  gstin: '27AABCS1429P1ZQ',
  dlNos: ['MH-PN2-20B', 'MH-PN2-21B'],
  invoicePrefix: 'RX',
  financialYearStartMonth: 4,
  currency: '₹',
  expiryGuardDays: 30,
  nearExpiryBuckets: [180, 90, 60, 30],
  roundOffEnabled: true,
  allowNegativeStock: false,
  upiVpa: 'sanjeevanimeds@okicici',
  footerNote: 'Medicines once sold are not returnable without a valid bill. Store below 25°C.',
  /* Settings, not law. Every one of these is recorded in docs/UNVERIFIED.md;
     shipping them as editable defaults with the figure printed wherever it is
     applied is the only honest way to hold a threshold nobody has confirmed. */
  filing: { b2clMinimum: '250000.00', rule46Minimum: '50000.00', hsnDigits: 6 },
}

/**
 * The chain's second branch.
 *
 * A second store is not decoration: `storeId` is on every transactional row from
 * the first migration precisely because retrofitting store scoping is the
 * classic rewrite trigger, and a single-store demo lets that scoping rot
 * untested. Two stores means the filters are exercised every time anybody opens
 * the app.
 *
 * Deliberately DIFFERENT where it matters:
 *
 *  - Its own invoice prefix, so a document number says which branch raised it
 *    at a glance and the two series can never be confused for one.
 *  - A different city on the same GSTIN state — a chain within one state, which
 *    is the ordinary case and keeps both branches on CGST+SGST.
 *  - Its own drug licences, because those are issued per premises. Sharing them
 *    would be the one thing on this record that is actually illegal.
 */
export const DEMO_STORE_2: StoreProfile = {
  ...DEMO_STORE,
  id: 2,
  name: 'Sanjeevani Medical — Kothrud',
  tagline: 'Branch since 2016',
  addressLine: 'Shop 4, Paud Road',
  city: 'Kothrud, Pune',
  phone: '+91 98220 41155',
  gstin: '27AABCS1429P1ZQ',
  dlNos: ['MH-PN4-118B', 'MH-PN4-119B'],
  invoicePrefix: 'KT',
  upiVpa: 'sanjeevanikothrud@okicici',
}

/** Every branch this build knows about. The chip switches between these. */
export const DEMO_STORES: StoreProfile[] = [DEMO_STORE, DEMO_STORE_2]

/* The fallback brand lives in brand/applyBrand.ts, which owns the whole branding
   contract. Re-declaring it here gave two sources of truth for one fallback: they
   were byte-identical until the day somebody edited one. */
export { DEFAULT_BRAND } from '@/brand/applyBrand'

/** A slab change part-way through the data, so the crossover path is live. */
const SLAB_CHANGE = '2025-09-22'

/**
 * Output rates, DERIVED from the HSN codes the catalogue actually uses.
 *
 * A hand-written list is how this went wrong once already: the medicine seed used
 * 30042099 while the rate list carried 30042000, so `resolveGstRate` threw for
 * most of the catalogue and every bill silently priced at zero. Deriving the rows
 * from the distinct codes in the catalogue makes that class of gap impossible —
 * a new HSN in the seed always gets a rate.
 */
function classify(hsn: string): { before: string; after: string } {
  // Oral rehydration salts are nil-rated. Keeping one genuinely zero-rated line
  // in the demo is what proves the bill handles a MIXED-rate GST breakup.
  if (hsn === '30049069') return { before: '0', after: '0' }
  if (hsn.startsWith('21') || hsn.startsWith('33')) return { before: '18', after: '18' }
  if (hsn.startsWith('3003') || hsn.startsWith('3004') || hsn.startsWith('3005')) {
    return { before: '12', after: '5' }
  }
  if (hsn.startsWith('3822') || hsn.startsWith('9018') || hsn.startsWith('9025')) {
    return { before: '12', after: '5' }
  }
  return { before: '12', after: '5' }
}

export function buildTaxRates(hsnCodes: readonly string[]): TaxRateRow[] {
  const distinct = [...new Set(hsnCodes)].sort()
  return distinct.flatMap((hsnCode) => {
    const { before, after } = classify(hsnCode)
    if (before === after) {
      return [{ hsnCode, effectiveFrom: '2017-07-01', effectiveTo: null, ratePct: after, notificationRef: 'demo:flat' }]
    }
    return [
      { hsnCode, effectiveFrom: '2017-07-01', effectiveTo: '2025-09-21', ratePct: before, notificationRef: 'demo:pre-revision' },
      { hsnCode, effectiveFrom: SLAB_CHANGE, effectiveTo: null, ratePct: after, notificationRef: 'demo:post-revision' },
    ]
  })
}

export const DEMO_CUSTOMERS: Array<Omit<Customer, 'id'>> = [
  { storeId: 1, name: 'Ramesh Kulkarni', phone: '9822041100', address: 'Flat 4, Sahyadri Apts, Deccan', gstin: null, allergies: ['Penicillin'], creditLimit: '5000.00', outstanding: '1240.00' },
  { storeId: 1, name: 'Sunita Deshpande', phone: '9765432101', address: '22, Erandwane', gstin: null, allergies: [], creditLimit: '2000.00', outstanding: '0.00' },
  { storeId: 1, name: 'Dr. A. K. Joshi Clinic', phone: '9890011223', address: '3rd Floor, Shivneri Complex', gstin: '27AAECJ1234K1Z5', allergies: [], creditLimit: '50000.00', outstanding: '18450.00' },
  { storeId: 1, name: 'Farhan Shaikh', phone: '9028887766', address: 'Kondhwa', gstin: null, allergies: ['Sulfa', 'Aspirin'], creditLimit: '0.00', outstanding: '0.00' },
  { storeId: 1, name: 'Meera Iyer', phone: '9922334455', address: 'Baner Road', gstin: null, allergies: [], creditLimit: '3000.00', outstanding: '420.50' },
  { storeId: 1, name: 'Vikram Patil', phone: '9860123456', address: 'Kothrud', gstin: null, allergies: ['Ibuprofen'], creditLimit: '1000.00', outstanding: '0.00' },
]

/**
 * The prescriber master.
 *
 * INVENTED RECORDS. No name, clinic or registration number below belongs to a
 * real practitioner; the numbers only imitate the shape of a state-council
 * registration so the Rule 65 bill footer and the H1 register have something
 * realistic to lay out.
 *
 * `prescriptionCount` is deliberately not in name order. The quick-pick list is
 * ordered by how often a prescriber is actually billed against — a demo that
 * happens to come out A-Z would hide whether that ordering works at all.
 */
export const DEMO_DOCTORS: Array<Omit<Doctor, 'id'>> = [
  { storeId: 1, name: 'Dr. Suresh Pawar', registrationNo: 'MMC/1995/012477', qualification: 'MBBS', clinicName: 'Pawar Family Clinic, Shivaji Market', phone: '9822330099', prescriptionCount: 289 },
  { storeId: 1, name: 'Dr. Anil Deshmukh', registrationNo: 'MMC/2004/031728', qualification: 'MBBS, MD (Medicine)', clinicName: 'Deshmukh Polyclinic, MG Road', phone: '9822014477', prescriptionCount: 214 },
  { storeId: 1, name: 'Dr. Sneha Kulkarni', registrationNo: 'MMC/2011/047312', qualification: 'MBBS, DCH', clinicName: 'Aarogya Child Care, Deccan', phone: '9767112233', prescriptionCount: 168 },
  { storeId: 1, name: 'Dr. Farida Merchant', registrationNo: 'MMC/2007/039215', qualification: 'MBBS, DGO', clinicName: 'Matrusewa Nursing Home, Erandwane', phone: '9822776655', prescriptionCount: 143 },
  { storeId: 1, name: 'Dr. Rajesh Iyer', registrationNo: 'MMC/1998/018904', qualification: 'MBBS, MS (Orthopaedics)', clinicName: 'Sahyadri Bone & Joint Centre', phone: '9890443311', prescriptionCount: 96 },
  { storeId: 1, name: 'Dr. Imran Sayyed', registrationNo: 'MMC/2009/044150', qualification: 'MBBS, MD (Pulmonary Medicine)', clinicName: 'Sayyed Chest & Asthma Clinic, Kondhwa', phone: '9975118822', prescriptionCount: 78 },
  { storeId: 1, name: 'Dr. Meenakshi Rao', registrationNo: 'MMC/2013/052880', qualification: 'MBBS, MD (Dermatology)', clinicName: 'Skin & Hair Clinic, Baner', phone: '9860227744', prescriptionCount: 61 },
  { storeId: 1, name: 'Dr. Kavita Bhosale', registrationNo: 'MMC/2015/061033', qualification: 'MBBS, DNB (Cardiology)', clinicName: 'Heartcare Pune, Karve Road', phone: '9922556677', prescriptionCount: 52 },
  { storeId: 1, name: 'Dr. Prashant Jadhav', registrationNo: 'MSDC/A-11248', qualification: 'BDS', clinicName: 'Smile Dental Studio, Kothrud', phone: '9028113344', prescriptionCount: 37 },
  { storeId: 1, name: 'Dr. Vivek Ranade', registrationNo: 'MMC/2002/026641', qualification: 'MBBS, MS (General Surgery)', clinicName: 'Ranade Surgical Hospital, Sinhagad Road', phone: '9850441122', prescriptionCount: 24 },
]

/**
 * The distributor master.
 *
 * INVENTED RECORDS. No firm, GSTIN or drug licence number below belongs to a
 * real business; they only imitate the SHAPE of the real thing so the purchase
 * bill, the GSTIN state-code check and the ageing view have something realistic
 * to lay out.
 *
 * Two of these are load-bearing rather than decorative:
 *
 *  - Meditrust is registered in Gujarat (GSTIN state code 24) against a store in
 *    Maharashtra (27), so `isInterStateSupply` resolves to IGST on its bills.
 *    A demo where every supplier is local never exercises the branch, and the
 *    first inter-state purchase in production would be the first test of it.
 *  - Pawar Medical Traders has no GSTIN at all — an unregistered local trader is
 *    ordinary, and the receipt screen has to price a bill from one without
 *    inventing an input credit that nobody paid.
 *
 * `outstanding` is deliberately uneven, including one supplier paid up to zero:
 * an ageing list where every row owes money hides whether the zero case renders.
 */
export const DEMO_SUPPLIERS: Array<Omit<Supplier, 'id'>> = [
  { storeId: 1, name: 'Sanjivani Pharma Distributors', phone: '2026441120', address: 'Plot 14, Bhosari MIDC, Pune 411026', gstin: '27AACCS4471M1ZB', dlNo: 'MH-PN1-114B', paymentTermsDays: 30, creditLimit: '500000.00', outstanding: '184320.50' },
  { storeId: 1, name: 'Deccan Medical Agencies', phone: '2025536677', address: '3, Laxmi Road, Shukrawar Peth, Pune 411002', gstin: '27AABFD9012K1Z7', dlNo: 'MH-PN2-2091B', paymentTermsDays: 21, creditLimit: '250000.00', outstanding: '62740.00' },
  { storeId: 1, name: 'Wellness Drug House', phone: '2266718890', address: 'Unit 7, Marol Industrial Estate, Andheri East, Mumbai 400059', gstin: '27AAECW3388L1ZQ', dlNo: 'MH-MU5-8842B', paymentTermsDays: 45, creditLimit: '750000.00', outstanding: '0.00' },
  { storeId: 1, name: 'Krishna Surgicals & Devices', phone: '9822114477', address: 'Shop 22, Nana Peth, Pune 411002', gstin: '27AAGCK1245P1ZF', dlNo: 'MH-PN2-3312B', paymentTermsDays: 15, creditLimit: '150000.00', outstanding: '23890.75' },
  { storeId: 1, name: 'Meditrust Distributors', phone: '7926584411', address: '48, Naroda Industrial Area, Ahmedabad 382330', gstin: '24AAACM6677R1ZK', dlNo: 'GJ-AH1-5527B', paymentTermsDays: 30, creditLimit: '400000.00', outstanding: '97155.00' },
  { storeId: 1, name: 'Shree Nutricare Agencies', phone: '2027451188', address: 'B-9, Kothrud Industrial Estate, Pune 411038', gstin: '27AAJFS2210Q1ZD', dlNo: 'MH-PN4-1180B', paymentTermsDays: 30, creditLimit: '120000.00', outstanding: '14620.00' },
  { storeId: 1, name: 'Pawar Medical Traders', phone: '9860227733', address: 'Sinhagad Road, Pune 411030', gstin: null, dlNo: 'MH-PN6-7741B', paymentTermsDays: 0, creditLimit: '25000.00', outstanding: '3410.00' },
]

/**
 * How long each demo licence still has to run, in days from today.
 *
 * Kept as an OFFSET rather than a date because the rest of the demo is
 * clock-relative — batches, bills and ageing are all generated from `now` — and
 * a hard-coded 2027 licence would read as valid this year and expired for ever
 * after, which is the one state the renewal alarm must not be stuck in.
 *
 * The spread is the demonstration, not decoration. One licence has already
 * lapsed, one runs out inside the month, one inside the quarter, and one is
 * simply not on file: those four are every state the compliance column has to
 * render, and a master where all seven are healthy never shows any of them.
 */
export const DEMO_DL_VALIDITY_DAYS: ReadonlyArray<number | null> = [
  612,   // Sanjivani — renewed recently
  -23,   // Deccan — LAPSED. Buying from him today is the finding.
  41,    // Wellness — inside the renewal window
  1004,  // Krishna
  88,    // Meditrust — inside the quarter
  null,  // Shree Nutricare — number on file, validity never recorded
  268,   // Pawar
]

/** The distributor master with its licence dates resolved against a clock. */
export function demoSuppliers(now: Date): Array<Omit<Supplier, 'id'>> {
  return DEMO_SUPPLIERS.map((s, i) => {
    const days = DEMO_DL_VALIDITY_DAYS[i]
    return days === undefined || days === null ? s : { ...s, dlValidUpto: isoDay(now, days) }
  })
}

function isoDay(from: Date, plusDays: number): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + plusDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ------------------------------------------------------------- the roster ---

/* The per-role starting limits live in `api/users.ts`, next to the hard ceilings
   they have to sit under. Restating them here would give one rule two homes,
   which is how the brand fallback went wrong once already. */
export { ROLE_STARTING_LIMITS } from '@/api/users'

/**
 * The people on the counter.
 *
 * INVENTED RECORDS. No name or registration number below belongs to a real
 * pharmacist; the numbers only imitate the shape of a state-council
 * registration so the bill footer and the H1 register have something realistic
 * to lay out. Ids are literal rather than auto-assigned because the audit trail
 * below points at them.
 *
 * The limits are deliberately UNEVEN, and that is the demonstration:
 *
 *  - Two cashiers, two discount ceilings. Akib has been on the counter four
 *    years and gives 5%; Rekha started in March and gives 3. A role cannot say
 *    that, and a shop that cannot say it either gives the new one too much rope
 *    or ties the experienced one to a manager for every rupee off.
 *  - Imran is a pharmacist with the cost flag OFF. He dispenses and receives
 *    goods, but this shop does not show him landed cost yet. It is the case
 *    that proves the flag is a second gate and not a synonym for the role.
 *  - Vinod left in June. His account is disabled, not deleted, because his
 *    username is on four hundred bills and the trail has to keep resolving it.
 */
export const DEMO_USERS: User[] = [
  {
    id: 1, storeId: 1, name: 'Harshad Kulkarni', username: 'harshad', role: 'admin',
    pharmacistRegNo: 'MSPC/1996/018842',
    limits: { maxDiscountPct: '100', maxRefundAmount: '1000000.00', backdateDays: 365, canViewCost: true },
    isActive: true, lastActiveAt: null,
  },
  {
    id: 2, storeId: 1, name: 'Prakash Nene', username: 'prakash', role: 'manager',
    pharmacistRegNo: null,
    limits: { maxDiscountPct: '25', maxRefundAmount: '10000.00', backdateDays: 7, canViewCost: true },
    isActive: true, lastActiveAt: null,
  },
  {
    id: 3, storeId: 1, name: 'Sunita Deshpande', username: 'sunita', role: 'pharmacist',
    pharmacistRegNo: 'MSPC/2011/034120',
    limits: { maxDiscountPct: '10', maxRefundAmount: '2000.00', backdateDays: 1, canViewCost: true },
    isActive: true, lastActiveAt: null,
  },
  {
    id: 4, storeId: 1, name: 'Imran Sayyed', username: 'imran', role: 'pharmacist',
    pharmacistRegNo: 'MSPC/2019/051977',
    limits: { maxDiscountPct: '8', maxRefundAmount: '1500.00', backdateDays: 1, canViewCost: false },
    isActive: true, lastActiveAt: null,
  },
  {
    id: 5, storeId: 1, name: 'Akib Shaikh', username: 'akib', role: 'cashier',
    pharmacistRegNo: null,
    limits: { maxDiscountPct: '5', maxRefundAmount: '500.00', backdateDays: 0, canViewCost: false },
    isActive: true, lastActiveAt: null,
  },
  {
    id: 6, storeId: 1, name: 'Rekha Pawar', username: 'rekha', role: 'cashier',
    pharmacistRegNo: null,
    limits: { maxDiscountPct: '3', maxRefundAmount: '300.00', backdateDays: 0, canViewCost: false },
    isActive: true, lastActiveAt: null,
  },
  {
    id: 7, storeId: 1, name: 'Vinod Gaikwad', username: 'vinod', role: 'cashier',
    pharmacistRegNo: null,
    limits: { maxDiscountPct: '5', maxRefundAmount: '500.00', backdateDays: 0, canViewCost: false },
    isActive: false, lastActiveAt: null,
  },
]

/** Who the demo signs in as. The owner, so the page is not itself locked. */
export const DEMO_CURRENT_USER_ID = 1

function actorOf(id: number): Pick<AuditEntry, 'actorId' | 'actorName' | 'actorRole'> {
  const u = DEMO_USERS.find((x) => x.id === id)
  // The ids below are literals from this same file, so a miss is a typo rather
  // than a state the app can reach. Loud beats a row that says "undefined did".
  if (!u) throw new Error(`demo audit references unknown user ${id}`)
  return { actorId: u.id, actorName: u.name, actorRole: u.role }
}

function approverOf(id: number): { approverId: number; approverName: string } {
  const u = DEMO_USERS.find((x) => x.id === id)
  if (!u) throw new Error(`demo override references unknown approver ${id}`)
  return { approverId: u.id, approverName: u.name }
}

/** Local wall-clock, `daysAgo` days back. A shop's log is read in shop time. */
function at(now: Date, daysAgo: number, hh: number, mm: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hh, mm).getTime()
}

interface Seed {
  d: number
  hh: number
  mm: number
  by: number
  action: AuditAction
  entity: string
  ref: string
  summary: string
  amount?: Money
  terminal?: number
  changes?: AuditChange[]
  override?: {
    by: number
    reason: OverrideReason
    requested: string
    limit: string
    note?: string
  }
}

/**
 * A fortnight of counter activity.
 *
 * Written as a table rather than generated, because the point of the log is the
 * handful of rows an owner is actually hunting for and those have to be
 * SPECIFIC: the void with a manager's name against it, the MRP that moved by
 * eleven rupees, the 22% discount somebody signed for on a Sunday. A randomised
 * feed produces a screen that looks busy and answers nothing.
 *
 * Every override here is between two different people. That is not decoration —
 * it is invariant I22, and a demo that shipped one self-approved row would
 * teach the shape wrongly on the first read.
 */
const AUDIT_SEED: Seed[] = [
  // --- today -------------------------------------------------------------
  { d: 0, hh: 9, mm: 2, by: 5, action: 'LOGIN', entity: 'Terminal', ref: 'Till 1', summary: 'Signed in at the front counter', terminal: 1 },
  { d: 0, hh: 9, mm: 4, by: 3, action: 'LOGIN', entity: 'Terminal', ref: 'Till 2', summary: 'Signed in at the dispensing counter', terminal: 2 },
  { d: 0, hh: 10, mm: 18, by: 5, action: 'SALE_POSTED', entity: 'Bill', ref: 'RX2627-00412', summary: 'Cash sale, 6 lines', amount: '1284.50', terminal: 1 },
  {
    d: 0, hh: 11, mm: 41, by: 5, action: 'DISCOUNT_APPLIED', entity: 'Bill', ref: 'RX2627-00418',
    summary: '22% off a ₹3,200 bill for a hospital account', amount: '3200.00', terminal: 1,
    changes: [{ field: 'Discount %', before: '5', after: '22' }],
    override: { by: 2, reason: 'DISCOUNT_LIMIT', requested: '22', limit: '5', note: 'Standing arrangement with Joshi Clinic — confirmed on the phone' },
  },
  { d: 0, hh: 12, mm: 7, by: 3, action: 'SALE_POSTED', entity: 'Bill', ref: 'RX2627-00421', summary: 'Prescription sale against Dr. Suresh Pawar', amount: '742.00', terminal: 2 },
  {
    d: 0, hh: 13, mm: 26, by: 2, action: 'RATE_EDITED', entity: 'Batch', ref: 'DL2411A · Dolo 650',
    summary: 'MRP corrected to the figure printed on the strip',
    changes: [{ field: 'MRP per pack', before: '30.00', after: '41.00' }, { field: 'Source', before: 'Purchase bill', after: 'Printed pack' }],
    override: { by: 1, reason: 'RATE_EDIT', requested: '41.00', limit: '30.00', note: 'Distributor billed the old MRP; pack in hand says ₹41' },
  },
  { d: 0, hh: 14, mm: 3, by: 6, action: 'SALE_POSTED', entity: 'Bill', ref: 'RX2627-00427', summary: 'UPI sale, 2 lines', amount: '218.00', terminal: 1 },

  // --- yesterday ---------------------------------------------------------
  {
    d: 1, hh: 19, mm: 52, by: 6, action: 'SALE_VOIDED', entity: 'Bill', ref: 'RX2627-00398',
    summary: 'Voided after the customer walked out without the goods', amount: '1640.00', terminal: 1,
    changes: [{ field: 'Status', before: 'POSTED', after: 'VOIDED' }],
    override: { by: 2, reason: 'BILL_VOID', requested: '1640.00', limit: '0', note: 'Goods back on the shelf, checked by me' },
  },
  { d: 1, hh: 20, mm: 15, by: 6, action: 'CASH_COUNTED', entity: 'Drawer', ref: 'Till 1', summary: 'Closing count short by ₹120 against the day’s takings', amount: '-120.00', terminal: 1 },
  { d: 1, hh: 11, mm: 9, by: 3, action: 'STOCK_ADJUSTED', entity: 'Batch', ref: 'AZ2308B · Azithral 500', summary: 'Wrote off 6 tablets — strip crushed in the rack', amount: '-84.00' },
  { d: 1, hh: 16, mm: 30, by: 4, action: 'PURCHASE_POSTED', entity: 'Goods receipt', ref: 'GRN2627-00088', summary: 'Deccan Medical Agencies, 22 lines', amount: '62740.00' },
  { d: 1, hh: 9, mm: 1, by: 6, action: 'LOGIN', entity: 'Terminal', ref: 'Till 1', summary: 'Signed in at the front counter', terminal: 1 },

  // --- this week ---------------------------------------------------------
  {
    d: 2, hh: 12, mm: 44, by: 5, action: 'REFUND_ISSUED', entity: 'Credit note', ref: 'CN2627-00021',
    summary: 'Returned an unopened insulin pen, cold chain intact', amount: '1180.00', terminal: 1,
    override: { by: 3, reason: 'REFUND_LIMIT', requested: '1180.00', limit: '500.00', note: 'Pen sealed, box unopened, sold four days ago' },
  },
  { d: 2, hh: 15, mm: 12, by: 2, action: 'CREDIT_LIMIT_CHANGED', entity: 'Customer', ref: 'Dr. A. K. Joshi Clinic', summary: 'Raised the clinic’s credit ceiling before the quarter', changes: [{ field: 'Credit limit', before: '25000.00', after: '50000.00' }] },
  { d: 3, hh: 10, mm: 5, by: 3, action: 'BATCH_QUARANTINED', entity: 'Batch', ref: 'PN2502C · Pan 40', summary: 'Held for supplier return — 11 strips inside the expiry window' },
  {
    d: 3, hh: 18, mm: 39, by: 5, action: 'DOCUMENT_BACKDATED', entity: 'Bill', ref: 'RX2627-00361',
    summary: 'Dated to the 31st for a customer who paid on the 31st', terminal: 1,
    changes: [{ field: 'Invoice date', before: '2026-09-02', after: '2026-08-31' }],
    /* A DATE, not a day count. The contract documents `requested` as '2026-08-31'
       for a backdate and `evaluate` produces exactly that, but this row said '2'
       against a limit of '0' — so the card rendered "Limit 0 → 2" beside its own
       change pair of two dates, and a reader could not tell which unit was being
       quoted. Both sides now match the change rows directly above them. */
    override: { by: 2, reason: 'BACKDATE', requested: '2026-08-31', limit: '2026-09-02', note: 'Cash taken on the 31st, bill missed at close' },
  },
  { d: 4, hh: 11, mm: 22, by: 4, action: 'MEDICINE_EDITED', entity: 'Medicine', ref: 'Montek LC', summary: 'Corrected the pack label after a supplier change', changes: [{ field: 'Pack label', before: '1x10', after: '1x15' }, { field: 'Units per pack', before: '10', after: '15' }] },
  { d: 4, hh: 17, mm: 48, by: 2, action: 'EXPORT_RUN', entity: 'Report', ref: 'Sales register, Aug', summary: 'Exported the August sales register to CSV for the accountant' },
  { d: 5, hh: 9, mm: 33, by: 3, action: 'CUSTOMER_EDITED', entity: 'Customer', ref: 'Farhan Shaikh', summary: 'Added a sulfa allergy after a counter conversation', changes: [{ field: 'Allergies', before: 'Aspirin', after: 'Sulfa, Aspirin' }] },
  { d: 5, hh: 14, mm: 2, by: 5, action: 'SALE_POSTED', entity: 'Bill', ref: 'RX2627-00302', summary: 'Card sale, 11 lines', amount: '4210.00', terminal: 1 },
  {
    d: 6, hh: 13, mm: 15, by: 1, action: 'USER_UPDATED', entity: 'User', ref: 'akib',
    summary: 'Widened the front counter’s discount after four years on the till',
    changes: [{ field: 'Max discount %', before: '3', after: '5' }, { field: 'Max refund ₹', before: '300.00', after: '500.00' }],
  },
  { d: 7, hh: 10, mm: 41, by: 2, action: 'STOCK_ADJUSTED', entity: 'Batch', ref: 'GL2401D · Glycomet 500', summary: 'Physical count 14 tablets over the ledger — corrected up', amount: '112.00' },

  // --- last week ---------------------------------------------------------
  {
    d: 9, hh: 20, mm: 4, by: 7, action: 'SALE_VOIDED', entity: 'Bill', ref: 'RX2627-00214',
    summary: 'Voided at close with no goods returned to the shelf', amount: '2380.00', terminal: 1,
    changes: [{ field: 'Status', before: 'POSTED', after: 'VOIDED' }],
    override: { by: 1, reason: 'BILL_VOID', requested: '2380.00', limit: '0', note: 'Queried at the month end — see the June note' },
  },
  { d: 9, hh: 20, mm: 30, by: 7, action: 'CASH_COUNTED', entity: 'Drawer', ref: 'Till 1', summary: 'Closing count short by ₹2,380 — the amount of the voided bill', amount: '-2380.00', terminal: 1 },
  { d: 10, hh: 15, mm: 55, by: 1, action: 'USER_DEACTIVATED', entity: 'User', ref: 'vinod', summary: 'Account disabled on the last working day', changes: [{ field: 'Active', before: 'Yes', after: 'No' }] },
  { d: 11, hh: 9, mm: 12, by: 1, action: 'USER_CREATED', entity: 'User', ref: 'rekha', summary: 'New cashier, starting limits for the role', changes: [{ field: 'Role', before: null, after: 'Cashier' }, { field: 'Max discount %', before: null, after: '3' }] },
  { d: 12, hh: 12, mm: 20, by: 4, action: 'PURCHASE_POSTED', entity: 'Goods receipt', ref: 'GRN2627-00081', summary: 'Sanjivani Pharma Distributors, 41 lines', amount: '184320.50' },
  { d: 13, hh: 16, mm: 8, by: 2, action: 'RATE_EDITED', entity: 'Batch', ref: 'TX2409E · Taxim-O 200', summary: 'Selling rate dropped to match the shop across the road', changes: [{ field: 'Rate per unit', before: '48.00', after: '44.00' }] },
]

/**
 * The seeded trail, timed against `now`.
 *
 * Relative rather than absolute so the date filter has something to bite on
 * whenever the demo is opened — fixed timestamps age into an empty "last 7
 * days" within a fortnight of being written.
 */
export function buildDemoAudit(now: Date): AuditEntry[] {
  /* Slid back by WHOLE DAYS until nothing sits in the future.
     The seed is written in shop hours — signing on at nine, counting the drawer
     at eight — and opened before lunch it would otherwise show this afternoon
     already logged, which is the one thing an audit trail may never do. Sliding
     by a part-day would fix that and leave a pharmacy signing on at two in the
     morning; sliding by a day keeps every clock time exactly as written, at the
     cost of "today" being quiet in a demo opened at breakfast. Which is what a
     shop that opened an hour ago looks like. */
  const latest = Math.max(...AUDIT_SEED.map((s) => at(now, s.d, s.hh, s.mm)))
  const slip = Math.max(0, Math.ceil((latest - now.getTime()) / 86_400_000))

  return AUDIT_SEED.map((s, i) => ({
    id: i + 1,
    storeId: 1,
    at: new Date(at(now, s.d + slip, s.hh, s.mm)).toISOString(),
    ...actorOf(s.by),
    action: s.action,
    entity: s.entity,
    entityRef: s.ref,
    summary: s.summary,
    changes: s.changes ?? [],
    terminalId: s.terminal ?? null,
    amount: s.amount ?? null,
    override: s.override
      ? {
        requesterId: s.by,
        requesterName: actorOf(s.by).actorName,
        ...approverOf(s.override.by),
        reasonCode: s.override.reason,
        requested: s.override.requested,
        limit: s.override.limit,
        note: s.override.note ?? null,
      }
      : null,
  }))
}
