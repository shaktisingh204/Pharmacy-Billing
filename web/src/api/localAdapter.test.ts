import { describe, expect, it } from 'vitest'
import { ApiError } from '@contract'
import type { Batch, Customer, Doctor, Medicine } from '@contract'
import type { SubstituteSource } from './localAdapter'
import {
  doctorIdentity, findExistingDoctor, matchesDoctor, normaliseComposition,
  orderRecentCustomers, phoneDigits, prepareCustomer, prepareDoctor, substitutesFor,
} from './localAdapter'

/**
 * `fake-indexeddb` is not a dependency of this project and adding one for a test
 * is not worth it, so the adapter's rules are exercised where they actually live:
 * as pure functions over values. Everything asserted below is the part that can
 * be wrong — validation, de-duplication and ordering — rather than whether Dexie
 * writes a row, which is Dexie's test to run.
 */

const TODAY = '2026-09-08'

function medicine(id: number, over: Partial<Medicine> = {}): Medicine {
  return {
    id,
    storeId: 1,
    brandName: `Brand ${id}`,
    genericName: 'Amlodipine',
    compositionText: 'Amlodipine 5mg',
    manufacturer: 'Acme',
    form: 'Tablet',
    strengthText: '5mg',
    packLabel: '10x10',
    unitsPerPack: 10,
    baseUom: 'TAB',
    allowLooseSale: true,
    saleStep: '1',
    hsnCode: '30049099',
    drugSchedule: 'H',
    requiresPrescription: true,
    rackLocation: 'A1',
    reorderLevel: 100,
    saleRank: 0,
    isActive: true,
    ...over,
  }
}

function batch(id: number, medicineId: number, over: Partial<Batch> = {}): Batch {
  return {
    id,
    storeId: 1,
    medicineId,
    batchNo: `B${id}`,
    expiryDate: '2027-06-30',
    mrpPerPack: '100.00',
    mrpPerUnit: '10.0000',
    ptrPerUnit: '7.0000',
    landedCostPerUnit: '6.0000',
    purchaseGstPct: '12',
    qtyOnHand: '40',
    isQuarantined: false,
    ...over,
  }
}

function customer(id: number, over: Partial<Customer> = {}): Customer {
  return {
    id,
    storeId: 1,
    name: `Customer ${id}`,
    phone: `98220411${String(id).padStart(2, '0')}`,
    address: null,
    gstin: null,
    allergies: [],
    creditLimit: '0.00',
    outstanding: '0.00',
    ...over,
  }
}

function doctor(id: number, over: Partial<Doctor> = {}): Doctor {
  return {
    id,
    storeId: 1,
    name: `Dr. Physician ${id}`,
    registrationNo: `MMC/2004/0000${id}`,
    qualification: 'MBBS',
    clinicName: 'Demo Clinic',
    phone: null,
    prescriptionCount: 0,
    ...over,
  }
}

function source(medicines: readonly Medicine[], batches: readonly Batch[]): SubstituteSource {
  const byMedicine = new Map<number, Batch[]>()
  for (const b of batches) {
    const list = byMedicine.get(b.medicineId)
    if (list) list.push(b)
    else byMedicine.set(b.medicineId, [b])
  }
  return {
    medicines: new Map(medicines.map((m) => [m.id, m])),
    batchesFor: (id) => byMedicine.get(id) ?? [],
    today: TODAY,
  }
}

/** Asserts an ApiError was thrown and hands it back for inspection. */
function apiError(fn: () => unknown): ApiError {
  try {
    fn()
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error('expected an ApiError, nothing was thrown')
}

describe('phone normalisation', () => {
  it('reads the country code, the trunk zero and the spacing as one number', () => {
    expect(phoneDigits('+91 98220 41100')).toBe('9822041100')
    expect(phoneDigits('098220-41100')).toBe('9822041100')
    expect(phoneDigits('9822041100')).toBe('9822041100')
  })
})

describe('createCustomer validation', () => {
  it('accepts a 10-digit mobile and stores it in digits', () => {
    const row = prepareCustomer({ name: '  Ramesh   Kulkarni ', phone: '+91 98765 43210' }, [])
    expect(row.name).toBe('Ramesh Kulkarni')
    expect(row.phone).toBe('9876543210')
  })

  it('refuses a phone that is not 10 digits', () => {
    for (const phone of ['', '98765', '987654321', '98765432101', 'not a phone']) {
      const err = apiError(() => prepareCustomer({ name: 'Ramesh', phone }, []))
      expect(err.code).toBe('CUSTOMER_INVALID')
      expect(err.details).toEqual({ field: 'phone' })
    }
  })

  it('refuses an empty name', () => {
    const err = apiError(() => prepareCustomer({ name: '   ', phone: '9876543210' }, []))
    expect(err.code).toBe('CUSTOMER_INVALID')
    expect(err.details).toEqual({ field: 'name' })
  })

  it('starts a new customer at nothing outstanding', () => {
    const row = prepareCustomer({ name: 'Ramesh', phone: '9876543210', creditLimit: '5000' }, [])
    expect(row.outstanding).toBe('0.00')
    expect(row.creditLimit).toBe('5000.00')
    expect(row.address).toBeNull()
    expect(row.gstin).toBeNull()
  })

  it('drops blank allergies rather than writing an empty chip onto the bill', () => {
    const row = prepareCustomer(
      { name: 'Ramesh', phone: '9876543210', allergies: [' Penicillin ', '', '   '] },
      [],
    )
    expect(row.allergies).toEqual(['Penicillin'])
  })

  it('rejects a duplicate phone with the existing customer attached', () => {
    const existing = customer(7, { name: 'Ramesh Kulkarni', phone: '9822041100' })
    const err = apiError(() => prepareCustomer({ name: 'R. Kulkarni', phone: '9822041100' }, [existing]))
    expect(err.code).toBe('CUSTOMER_EXISTS')
    // The UI offers to attach this row instead of creating a second one.
    expect(err.details).toBe(existing)
    expect(err.message).toContain('Ramesh Kulkarni')
  })

  it('sees a duplicate through the formatting the operator typed', () => {
    const existing = customer(7, { phone: '9822041100' })
    const err = apiError(() => prepareCustomer({ name: 'Someone', phone: '+91 98220 41100' }, [existing]))
    expect(err.code).toBe('CUSTOMER_EXISTS')
  })

  it('lets a different number through', () => {
    const row = prepareCustomer({ name: 'Someone', phone: '9822041101' }, [customer(7, { phone: '9822041100' })])
    expect(row.phone).toBe('9822041101')
  })
})

describe('recentCustomers ordering', () => {
  it('puts the most recently billed first and the never-billed last, newest row first', () => {
    const rows = [customer(1), customer(2), customer(3), customer(4)]
    const billed = new Map([
      [1, '2026-09-01T10:00:00.000Z'],
      [3, '2026-09-07T18:30:00.000Z'],
    ])
    expect(orderRecentCustomers(rows, billed, 10).map((c) => c.id)).toEqual([3, 1, 4, 2])
  })

  it('never returns more than the limit', () => {
    const rows = [customer(1), customer(2), customer(3)]
    expect(orderRecentCustomers(rows, new Map(), 2)).toHaveLength(2)
    expect(orderRecentCustomers(rows, new Map(), 0)).toEqual([])
  })
})

describe('createDoctor de-duplication', () => {
  it('refuses an empty name', () => {
    const err = apiError(() => prepareDoctor({ name: '  ' }))
    expect(err.code).toBe('DOCTOR_INVALID')
  })

  it('trims and starts the prescription count at zero', () => {
    const row = prepareDoctor({ name: '  Dr.  Anil   Deshmukh ', registrationNo: ' MMC/2004/031728 ', qualification: '' })
    expect(row.name).toBe('Dr. Anil Deshmukh')
    expect(row.registrationNo).toBe('MMC/2004/031728')
    expect(row.qualification).toBeNull()
    expect(row.prescriptionCount).toBe(0)
  })

  it('treats case, spacing and the honorific as the same physician', () => {
    const existing = doctor(3, { name: 'Dr. Anil Deshmukh', registrationNo: 'MMC/2004/031728' })
    for (const name of ['DR. ANIL DESHMUKH', 'Anil   Deshmukh', 'dr anil deshmukh']) {
      const candidate = prepareDoctor({ name, registrationNo: 'mmc/2004/031728' })
      expect(findExistingDoctor([existing], candidate)).toBe(existing)
    }
  })

  it('keeps two prescribers apart when the registration numbers differ', () => {
    const existing = doctor(3, { name: 'Dr. Anil Deshmukh', registrationNo: 'MMC/2004/031728' })
    const candidate = prepareDoctor({ name: 'Dr. Anil Deshmukh', registrationNo: 'MMC/2011/047312' })
    expect(findExistingDoctor([existing], candidate)).toBeUndefined()
  })

  it('keys on name and registration together', () => {
    expect(doctorIdentity('Dr. A K Joshi', 'MMC/1')).toBe(doctorIdentity('  a  k joshi ', 'mmc/1'))
    expect(doctorIdentity('Dr. A K Joshi', 'MMC/1')).not.toBe(doctorIdentity('Dr. A K Joshi', 'MMC/2'))
  })

  it('searches the registration number and the clinic, not only the name', () => {
    const d = doctor(3, { name: 'Dr. Anil Deshmukh', registrationNo: 'MMC/2004/031728', clinicName: 'Deshmukh Polyclinic, MG Road' })
    expect(matchesDoctor(d, 'anil')).toBe(true)
    expect(matchesDoctor(d, '031728')).toBe(true)
    expect(matchesDoctor(d, 'mg road')).toBe(true)
    expect(matchesDoctor(d, 'kulkarni')).toBe(false)
  })
})

describe('findSubstitutes', () => {
  const AMLO = 'Amlodipine 5mg'
  const medicines = [
    medicine(1, { brandName: 'Amlogard', compositionText: AMLO }),
    // Same salt, printed with different case and spacing.
    medicine(2, { brandName: 'Amlopres', compositionText: 'amlodipine  5MG' }),
    medicine(3, { brandName: 'Stamlo', compositionText: AMLO }),
    // Brand-name lookalike on a different salt: the trap a brand match falls into.
    medicine(4, { brandName: 'Amlogard Plus', compositionText: 'Telmisartan 40mg' }),
    // Same molecule, different strength — a different medicine at the counter.
    medicine(5, { brandName: 'Amlovas', compositionText: 'Amlodipine 10mg' }),
    medicine(6, { brandName: 'Amlokind', compositionText: AMLO }),
    medicine(7, { brandName: 'Amdepin', compositionText: AMLO }),
  ]
  const batches = [
    batch(11, 1, { mrpPerUnit: '10.0000' }),
    batch(12, 2, { mrpPerUnit: '8.5000' }),
    batch(13, 3, { mrpPerUnit: '4.2500' }),
    batch(14, 4, { mrpPerUnit: '3.0000' }),
    batch(15, 5, { mrpPerUnit: '2.0000' }),
    // Amlokind is known but unsellable: nothing on hand.
    batch(16, 6, { mrpPerUnit: '1.0000', qtyOnHand: '0' }),
    // Amdepin has stock, but it expired last month.
    batch(17, 7, { mrpPerUnit: '1.5000', expiryDate: '2026-08-31' }),
  ]
  const src = source(medicines, batches)

  it('never offers the medicine back to itself', () => {
    expect(substitutesFor(1, src).map((h) => h.medicine.id)).not.toContain(1)
  })

  it('matches on the salt, not the brand name', () => {
    const ids = substitutesFor(1, src).map((h) => h.medicine.id)
    expect(ids).toContain(2)
    // 'Amlogard Plus' shares eight letters of the brand and none of the salt;
    // 'Amlovas' shares the molecule but not the strength.
    expect(ids).not.toContain(4)
    expect(ids).not.toContain(5)
  })

  it('offers the cheapest per unit first', () => {
    expect(substitutesFor(1, src).map((h) => h.medicine.brandName)).toEqual(['Stamlo', 'Amlopres'])
  })

  it('leaves out what cannot be dispensed today', () => {
    const ids = substitutesFor(1, src).map((h) => h.medicine.id)
    expect(ids).not.toContain(6)
    expect(ids).not.toContain(7)
  })

  it('populates the stock fields the search hit carries', () => {
    const hit = substitutesFor(1, src)[0]
    expect(hit?.medicine.brandName).toBe('Stamlo')
    expect(hit?.stockQty).toBe('40')
    expect(hit?.batchCount).toBe(1)
    expect(hit?.fefoBatch?.id).toBe(13)
    expect(hit?.matchedOn).toBe('composition')
    expect(hit?.outOfStock).toBe(false)
  })

  it('caps the list so the panel answers a question instead of listing a catalogue', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      medicine(100 + i, { brandName: `Alt ${i}`, compositionText: AMLO }))
    const manyBatches = many.map((m, i) => batch(200 + i, m.id, { mrpPerUnit: `${20 + i}.0000` }))
    const wide = source([...medicines, ...many], [...batches, ...manyBatches])
    expect(substitutesFor(1, wide)).toHaveLength(8)
  })

  it('returns nothing for a medicine it has never heard of', () => {
    expect(substitutesFor(999, src)).toEqual([])
  })

  it('normalises the composition it matches on', () => {
    expect(normaliseComposition('  Amlodipine   5MG ')).toBe('amlodipine 5mg')
  })
})
