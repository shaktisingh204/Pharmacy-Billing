import type { Customer, StoreProfile } from '@contract'
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
}

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
