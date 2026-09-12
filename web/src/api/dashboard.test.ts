import { describe, expect, it } from 'vitest'
import type {
  Batch, DrugSchedule, HeldBill, IsoDate, Medicine, PaymentInput, QuoteAllocation,
  QuoteLine, SaleInvoice, StoreProfile,
} from '@contract'
import * as D from '@/domain/decimal'
import { branchComparison, computeDashboard, rangeWindow } from './dashboard'
import type { DashboardDeps } from './dashboard'

/**
 * Fixtures are hand-written, not seeded. The seed is realistic but it moves; a
 * dashboard test that imports it stops asserting what the numbers mean and
 * starts asserting what the seed happens to contain this week.
 */

const TODAY: IsoDate = '2026-09-08'
const YESTERDAY: IsoDate = '2026-09-07'

/** Local wall-clock, serialised as the adapter serialises it, so the hour a sale
 *  lands in does not depend on the machine's timezone. */
const at = (day: number, hour: number, minute = 0): string =>
  new Date(2026, 8, day, hour, minute, 0, 0).toISOString()

function medicine(id: number, over: Partial<Medicine> = {}): Medicine {
  return {
    id,
    storeId: 1,
    brandName: `Brand ${id}`,
    genericName: null,
    compositionText: 'Paracetamol 650mg',
    manufacturer: 'Acme',
    form: 'Tablet',
    strengthText: '650mg',
    packLabel: '10x15',
    unitsPerPack: 15,
    baseUom: 'TAB',
    allowLooseSale: true,
    saleStep: '1',
    hsnCode: '30049099',
    drugSchedule: 'OTC',
    requiresPrescription: false,
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
    mrpPerPack: '150.00',
    mrpPerUnit: '10.0000',
    ptrPerUnit: '7.0000',
    landedCostPerUnit: '6.0000',
    purchaseGstPct: '12',
    qtyOnHand: '100.000',
    isQuarantined: false,
    ...over,
  }
}

interface LineSpec {
  medicineId: number
  drugSchedule: DrugSchedule
  qty: string
  taxableValue: string
  costBasis: string
  lineTotal: string
}

function saleLine(spec: LineSpec, i: number): QuoteLine {
  const allocation: QuoteAllocation = {
    batchId: 900 + i,
    batchNo: `A${i}`,
    expiryDate: '2027-06-30',
    qty: spec.qty,
    freeQty: '0',
    mrpPerUnit: '10.0000',
    ratePerUnit: '10.0000',
    grossAmount: spec.lineTotal,
    discountAmount: '0.00',
    taxableValue: spec.taxableValue,
    cgst: '0.00',
    sgst: '0.00',
    igst: '0.00',
    lineTotal: spec.lineTotal,
    gstRatePct: '5',
    costBasis: spec.costBasis,
  }
  return {
    lineId: `L${i}`,
    medicineId: spec.medicineId,
    brandName: `Brand ${spec.medicineId}`,
    packLabel: '10x15',
    hsnCode: '30049099',
    drugSchedule: spec.drugSchedule,
    requestedQty: spec.qty,
    allocatedQty: spec.qty,
    shortQty: '0',
    allocations: [allocation],
    discountPct: '0',
    grossAmount: spec.lineTotal,
    discountAmount: '0.00',
    taxableValue: spec.taxableValue,
    cgst: '0.00',
    sgst: '0.00',
    igst: '0.00',
    lineTotal: spec.lineTotal,
    manualBatch: false,
  }
}

interface InvoiceSpec {
  id: number
  invoiceDate: IsoDate
  createdAt: string
  netAmount: string
  lines: LineSpec[]
  customerId?: number | null
  payments?: PaymentInput[]
  status?: 'POSTED' | 'VOIDED'
}

function invoice(spec: InvoiceSpec): SaleInvoice {
  const lines = spec.lines.map(saleLine)
  const customerId = spec.customerId ?? null
  return {
    id: spec.id,
    invoiceNo: `INV-${spec.id}`,
    storeId: 1,
    terminalId: 1,
    invoiceDate: spec.invoiceDate,
    createdAt: spec.createdAt,
    customerId,
    customerName: customerId === null ? null : `Customer ${customerId}`,
    customerPhone: null,
    interState: false,
    quote: {
      lines,
      grossAmount: spec.netAmount,
      itemDiscount: '0.00',
      billDiscountPct: '0',
      billDiscount: '0.00',
      taxableValue: D.toStr(D.sum(lines.map((l) => D.dec(l.taxableValue))), 2),
      cgst: '0.00',
      sgst: '0.00',
      igst: '0.00',
      roundOff: '0.00',
      netAmount: spec.netAmount,
      taxBreakup: [],
      warnings: [],
      costOfGoods: '0.00',
    },
    payments: spec.payments ?? [{ mode: 'CASH', amount: spec.netAmount }],
    amountPaid: spec.netAmount,
    changeDue: '0.00',
    status: spec.status ?? 'POSTED',
    prescription: null,
    operatorName: 'Akib',
  }
}

const STORE: StoreProfile = {
  filing: { b2clMinimum: '250000.00', rule46Minimum: '50000.00', hsnDigits: 6 },
  id: 1,
  name: 'Test Medicals',
  tagline: null,
  addressLine: '1 Main Road',
  city: 'Kolkata',
  state: 'West Bengal',
  stateCode: '19',
  phone: '9999999999',
  email: null,
  gstin: '19AAAAA0000A1Z5',
  dlNos: ['WB-1'],
  invoicePrefix: 'TM',
  financialYearStartMonth: 4,
  currency: 'INR',
  expiryGuardDays: 30,
  nearExpiryBuckets: [30, 60, 90],
  roundOffEnabled: true,
  allowNegativeStock: false,
  upiVpa: null,
  footerNote: '',
}

const HELD: HeldBill = {
  token: 1,
  label: 'Counter 2',
  savedAt: at(8, 12),
  itemCount: 2,
  netAmount: '250.00',
  lines: [],
}

// Six medicines so the schedule mix can overflow its five-slice cap.
const MEDICINES: Medicine[] = [
  medicine(1, { drugSchedule: 'OTC', reorderLevel: 100 }),
  medicine(2, { drugSchedule: 'H', reorderLevel: 50 }),
  medicine(3, { drugSchedule: 'H1', reorderLevel: 20 }),
  medicine(4, { drugSchedule: 'G', reorderLevel: 30 }),
  medicine(5, { drugSchedule: 'X', reorderLevel: 10 }),
  medicine(6, { drugSchedule: 'NRx', reorderLevel: 10 }),
]

const BATCHES: Batch[] = [
  batch(1, 1, { expiryDate: '2027-06-30', qtyOnHand: '400.000' }), // healthy
  batch(2, 2, { expiryDate: '2026-09-20', qtyOnHand: '30.000' }), // 12 days out
  batch(3, 3, { expiryDate: '2026-08-31', qtyOnHand: '12.000' }), // expired, holds stock
  batch(4, 4, { expiryDate: '2027-01-31', qtyOnHand: '5.000' }), // in date, shelf is short
  batch(5, 5, { expiryDate: '2027-12-31', qtyOnHand: '0.000' }), // exhausted
  batch(6, 6, { expiryDate: '2026-11-15', qtyOnHand: '8.000' }), // 68 days out
]

const INVOICES: SaleInvoice[] = [
  invoice({
    id: 1,
    invoiceDate: TODAY,
    createdAt: at(8, 9, 15),
    netAmount: '105.00',
    lines: [{ medicineId: 1, drugSchedule: 'OTC', qty: '10', taxableValue: '100.00', costBasis: '60.00', lineTotal: '105.00' }],
  }),
  invoice({
    id: 2,
    invoiceDate: TODAY,
    createdAt: at(8, 14, 5),
    netAmount: '210.00',
    lines: [{ medicineId: 2, drugSchedule: 'H', qty: '6', taxableValue: '200.00', costBasis: '150.00', lineTotal: '210.00' }],
  }),
  invoice({
    id: 3,
    invoiceDate: TODAY,
    createdAt: at(8, 19, 30),
    netAmount: '315.00',
    customerId: 7,
    payments: [{ mode: 'CREDIT', amount: '315.00' }],
    lines: [{ medicineId: 3, drugSchedule: 'H1', qty: '4', taxableValue: '300.00', costBasis: '180.00', lineTotal: '315.00' }],
  }),
  invoice({
    id: 4,
    invoiceDate: YESTERDAY,
    createdAt: at(7, 11),
    netAmount: '105.00',
    customerId: 7,
    payments: [{ mode: 'CREDIT', amount: '105.00' }],
    lines: [{ medicineId: 1, drugSchedule: 'OTC', qty: '10', taxableValue: '100.00', costBasis: '70.00', lineTotal: '105.00' }],
  }),
]

function deps(over: Partial<DashboardDeps> = {}): DashboardDeps {
  return {
    medicines: MEDICINES,
    batches: BATCHES,
    invoices: INVOICES,
    shortbook: [{ medicineId: 9, term: 'Insulin glargine', at: at(8, 10, 40) }],
    heldBills: [HELD],
    store: STORE,
    today: TODAY,
    ...over,
  }
}

const sumPct = (parts: readonly string[]): string =>
  D.toStr(D.sum(parts.map((p) => D.dec(p))), 2)

describe('computeDashboard — KPIs', () => {
  it('sums today\'s posted sales and compares against the previous day', () => {
    const d = computeDashboard(deps())
    expect(d.date).toBe(TODAY)
    expect(d.kpis.sales.value).toBe('630.00')
    expect(d.kpis.sales.deltaPct).toBe('500.00')
    expect(d.kpis.sales.riseIsGood).toBe(true)
    expect(d.kpis.orders.value).toBe('3')
  })

  it('takes profit from the allocation costBasis, not from a margin guess', () => {
    const d = computeDashboard(deps())
    // (100-60) + (200-150) + (300-180). A percentage-of-revenue guess would give
    // anything but this, and would drift the moment landed cost changed.
    expect(d.kpis.profit.value).toBe('210.00')
    expect(d.kpis.grossMarginPct.value).toBe('35.00')
  })

  it('reads a thin margin off costBasis even when the bill is large', () => {
    const d = computeDashboard(deps({
      invoices: [invoice({
        id: 10,
        invoiceDate: TODAY,
        createdAt: at(8, 10),
        netAmount: '1180.00',
        lines: [{ medicineId: 1, drugSchedule: 'OTC', qty: '10', taxableValue: '1000.00', costBasis: '999.00', lineTotal: '1180.00' }],
      })],
    }))
    expect(d.kpis.profit.value).toBe('1.00')
    expect(d.kpis.grossMarginPct.value).toBe('0.10')
  })

  it('collapses walk-ins into a single customer bucket', () => {
    const walkIns = [1, 2, 3].map((n) => invoice({
      id: n,
      invoiceDate: TODAY,
      createdAt: at(8, 9 + n),
      netAmount: '100.00',
      customerId: null,
      lines: [{ medicineId: 1, drugSchedule: 'OTC', qty: '1', taxableValue: '95.00', costBasis: '50.00', lineTotal: '100.00' }],
    }))
    const d = computeDashboard(deps({ invoices: walkIns }))
    expect(d.kpis.orders.value).toBe('3')
    expect(d.kpis.customers.value).toBe('1')
  })

  it('counts a walk-in bucket alongside identified customers', () => {
    const d = computeDashboard(deps())
    expect(d.kpis.customers.value).toBe('2')
  })

  it('emits a null deltaPct rather than a fabricated +100% with no prior day', () => {
    const d = computeDashboard(deps({ invoices: INVOICES.filter((i) => i.invoiceDate === TODAY) }))
    expect(d.kpis.sales.deltaPct).toBeNull()
    expect(d.kpis.orders.deltaPct).toBeNull()
    expect(d.kpis.profit.deltaPct).toBeNull()
    expect(d.kpis.customers.deltaPct).toBeNull()
    expect(d.kpis.grossMarginPct.deltaPct).toBeNull()
    expect(d.kpis.overdue.deltaPct).toBeNull()
  })

  it('emits a null deltaPct rather than inverting the sign off a loss-making day', () => {
    // Yesterday lost 100, today made 50. (50 - -100) / -100 divides out to -150%,
    // which would paint the best swing of the week red.
    const loss = invoice({
      id: 40,
      invoiceDate: YESTERDAY,
      createdAt: at(7, 10),
      netAmount: '100.00',
      lines: [{ medicineId: 1, drugSchedule: 'OTC', qty: '1', taxableValue: '100.00', costBasis: '200.00', lineTotal: '100.00' }],
    })
    const gain = invoice({
      id: 41,
      invoiceDate: TODAY,
      createdAt: at(8, 10),
      netAmount: '100.00',
      lines: [{ medicineId: 1, drugSchedule: 'OTC', qty: '1', taxableValue: '100.00', costBasis: '50.00', lineTotal: '100.00' }],
    })
    const d = computeDashboard(deps({ invoices: [loss, gain] }))
    expect(d.kpis.profit.value).toBe('50.00')
    expect(d.kpis.profit.deltaPct).toBeNull()
    expect(d.kpis.grossMarginPct.deltaPct).toBeNull()
  })

  it('reads as at the requested date, ignoring bills dated after it', () => {
    const later = invoice({
      id: 42,
      invoiceDate: '2026-09-30',
      createdAt: at(30, 10),
      netAmount: '999.00',
      lines: [{ medicineId: 1, drugSchedule: 'OTC', qty: '1', taxableValue: '900.00', costBasis: '100.00', lineTotal: '999.00' }],
    })
    const d = computeDashboard(deps({ invoices: [...INVOICES, later] }))
    expect(d.kpis.sales.value).toBe('630.00')
    // The September bar and the feed must stop where the KPIs stop: 630 today
    // plus 105 yesterday, and nothing from the 30th.
    expect(d.salesTrend[11]?.values['2026-27']).toBe('735.00')
    expect(d.activity.map((r) => r.id)).not.toContain('sale:42')
  })

  it('ignores voided invoices', () => {
    const voided = INVOICES.map((i) => (i.id === 1 ? { ...i, status: 'VOIDED' as const } : i))
    const d = computeDashboard(deps({ invoices: voided }))
    expect(d.kpis.sales.value).toBe('525.00')
    expect(d.kpis.orders.value).toBe('2')
  })

  it('totals receivables and marks a rise as bad news', () => {
    const d = computeDashboard(deps())
    // Customer 7 took credit on both days; the walk-ins owe nothing.
    expect(d.kpis.overdue.value).toBe('420.00')
    expect(d.kpis.overdue.deltaPct).toBe('300.00')
    expect(d.kpis.overdue.riseIsGood).toBe(false)
  })
})

describe('computeDashboard — attention', () => {
  it('separates the four stock queues', () => {
    const d = computeDashboard(deps()).attention
    expect(d.lowStock).toBe(3) // medicines 2, 4 and 6 hold stock at or below reorder
    expect(d.outOfStock).toBe(2) // 3 (expired only) and 5 (exhausted)
    expect(d.nearExpiry30).toBe(1) // batch 2, twelve days out
    expect(d.expired).toBe(1) // batch 3, still holding twelve units
    expect(d.heldBills).toBe(1)
    expect(d.shortbook).toBe(1)
  })

  it('keeps a delisted medicine out of the reorder queue and its alerts', () => {
    const delisted = MEDICINES.map((m) => (m.id === 4 ? { ...m, isActive: false } : m))
    const d = computeDashboard(deps({ medicines: delisted }))
    expect(d.attention.lowStock).toBe(2)
    expect(d.lowStock.map((r) => r.medicineId)).toEqual([2, 6])
    expect(d.activity.filter((r) => r.id === 'low-stock:4')).toEqual([])
    // Its batch is no longer "the shelf behind it is short" — nothing is ordering it.
    const h = d.inventoryHealth
    expect(h).toMatchObject({ healthy: 2, lowStock: 1 })
    expect(h.healthy + h.lowStock + h.nearExpiry + h.expired).toBe(h.totalBatches)
  })

  it('counts a quarantined expired batch that still holds stock', () => {
    const quarantined = BATCHES.map((b) => (b.id === 3 ? { ...b, isQuarantined: true } : b))
    expect(computeDashboard(deps({ batches: quarantined })).attention.expired).toBe(1)
  })
})

describe('computeDashboard — category mix', () => {
  it('sums sharePct to exactly 100.00 when the split does not divide evenly', () => {
    const thirds = invoice({
      id: 20,
      invoiceDate: TODAY,
      createdAt: at(8, 11),
      netAmount: '30.00',
      lines: [
        { medicineId: 1, drugSchedule: 'OTC', qty: '1', taxableValue: '10.00', costBasis: '5.00', lineTotal: '10.00' },
        { medicineId: 2, drugSchedule: 'H', qty: '1', taxableValue: '10.00', costBasis: '5.00', lineTotal: '10.00' },
        { medicineId: 3, drugSchedule: 'H1', qty: '1', taxableValue: '10.00', costBasis: '5.00', lineTotal: '10.00' },
      ],
    })
    const mix = computeDashboard(deps({ invoices: [thirds] })).categoryMix
    expect(mix).toHaveLength(3)
    expect(sumPct(mix.map((c) => c.sharePct))).toBe('100.00')
    expect(mix.map((c) => c.sharePct)).toEqual(['33.34', '33.33', '33.33'])
  })

  it('caps at five slices, folds the tail into Other, and still sums to 100.00', () => {
    const schedules: DrugSchedule[] = ['OTC', 'H', 'H1', 'G', 'X', 'NRx']
    const wide = invoice({
      id: 21,
      invoiceDate: TODAY,
      createdAt: at(8, 11),
      netAmount: '210.00',
      lines: schedules.map((s, i) => ({
        medicineId: i + 1,
        drugSchedule: s,
        qty: '1',
        taxableValue: `${(6 - i) * 10}.00`,
        costBasis: '1.00',
        lineTotal: `${(6 - i) * 10}.00`,
      })),
    })
    const mix = computeDashboard(deps({ invoices: [wide] })).categoryMix
    expect(mix).toHaveLength(5)
    expect(mix.map((c) => c.key)).toEqual(['OTC', 'H', 'H1', 'G', 'OTHER'])
    expect(mix[4]?.value).toBe('30.00') // 20 (X) + 10 (NRx)
    expect(sumPct(mix.map((c) => c.sharePct))).toBe('100.00')
    // Descending, so the donut reads clockwise from the biggest slice.
    expect(mix.map((c) => c.value)).toEqual(['60.00', '50.00', '40.00', '30.00', '30.00'])
  })

  it('returns no slices rather than a zero-total donut on a day with no sales', () => {
    expect(computeDashboard(deps({ invoices: [] })).categoryMix).toEqual([])
  })
})

describe('computeDashboard — inventory health', () => {
  it('puts every batch in exactly one bucket', () => {
    const h = computeDashboard(deps()).inventoryHealth
    expect(h.totalBatches).toBe(BATCHES.length)
    expect(h.healthy + h.lowStock + h.nearExpiry + h.expired).toBe(h.totalBatches)
    expect(h).toMatchObject({ healthy: 1, lowStock: 2, nearExpiry: 2, expired: 1 })
  })

  it('values only the near-expiry window at landed cost', () => {
    // batch 2: 30 x 6.0000, batch 6: 8 x 6.0000.
    expect(computeDashboard(deps()).inventoryHealth.valueAtRisk).toBe('228.00')
  })
})

describe('computeDashboard — trends', () => {
  it('always emits twelve months, even for a single sale', () => {
    const one = invoice({
      id: 30,
      invoiceDate: TODAY,
      createdAt: at(8, 10),
      netAmount: '500.00',
      lines: [{ medicineId: 1, drugSchedule: 'OTC', qty: '1', taxableValue: '480.00', costBasis: '400.00', lineTotal: '500.00' }],
    })
    const d = computeDashboard(deps({ invoices: [one] }))
    expect(d.salesTrend).toHaveLength(12)
    expect(d.salesTrend.map((p) => p.label)).toEqual(
      ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'],
    )
    expect(d.salesTrendSeries).toEqual(['2025-26', '2026-27'])
    // Every point carries every series key: a hole would shift the axis.
    for (const point of d.salesTrend) {
      expect(Object.keys(point.values).sort()).toEqual(['2025-26', '2026-27'])
    }
    expect(d.salesTrend[11]?.values).toEqual({ '2025-26': '0.00', '2026-27': '500.00' })
    expect(d.salesTrend[0]?.values).toEqual({ '2025-26': '0.00', '2026-27': '0.00' })
  })

  it('files a March sale in the previous financial year', () => {
    const march = invoice({
      id: 31,
      invoiceDate: '2026-03-15',
      createdAt: '2026-03-15T05:00:00.000Z',
      netAmount: '900.00',
      lines: [{ medicineId: 1, drugSchedule: 'OTC', qty: '1', taxableValue: '860.00', costBasis: '700.00', lineTotal: '900.00' }],
    })
    const d = computeDashboard(deps({ invoices: [march] }))
    expect(d.salesTrend[5]).toEqual({ label: 'Mar', values: { '2025-26': '900.00', '2026-27': '0.00' } })
  })

  it('buckets today\'s takings by the hour they were rung up', () => {
    const d = computeDashboard(deps())
    expect(d.todayByHour).toHaveLength(16)
    expect(d.todayByHour[0]?.label).toBe('08:00')
    expect(d.todayByHour[15]?.label).toBe('23:00')
    const byLabel = new Map(d.todayByHour.map((p) => [p.label, p.values['sales']]))
    expect(byLabel.get('09:00')).toBe('105.00')
    expect(byLabel.get('14:00')).toBe('210.00')
    expect(byLabel.get('19:00')).toBe('315.00')
    expect(byLabel.get('08:00')).toBe('0.00')
    // The hourly chart must foot to the sales tile.
    expect(sumPct(d.todayByHour.map((p) => p.values['sales'] ?? '0'))).toBe('630.00')
  })
})

describe('computeDashboard — tables', () => {
  it('lists near-expiry stock soonest first, valued both ways', () => {
    const rows = computeDashboard(deps()).expiring
    expect(rows.map((r) => r.batchId)).toEqual([2, 6])
    expect(rows[0]).toMatchObject({
      brandName: 'Brand 2',
      daysLeft: 12,
      qtyOnHand: '30.000',
      valueAtMrp: '300.00',
      valueAtCost: '180.00',
    })
  })

  it('ranks low stock by shortfall against the reorder level', () => {
    const rows = computeDashboard(deps()).lowStock
    expect(rows.map((r) => r.medicineId)).toEqual([4, 2, 6])
    expect(rows[0]).toMatchObject({ shortfallPct: '83.33', qtyOnHand: '5.000', reorderLevel: 30 })
  })

  it('ranks top medicines by REVENUE, not by units', () => {
    // Base units are not comparable across pack shapes: a 100-tablet bottle scores
    // 100 where a 10-tablet strip scores 10, so a units ranking is really a ranking
    // of pack size. Medicine 3 sells fewer units than 1 and 2 and still outranks
    // them, which is the whole point.
    const rows = computeDashboard(deps()).topMedicines
    expect(rows.map((r) => r.medicineId)).toEqual([3, 1, 2])

    const revenues = rows.map((r) => Number(r.revenue))
    expect([...revenues].sort((a, b) => b - a)).toEqual(revenues)

    const top = rows[0]
    expect(top).toBeDefined()
    expect(Number(top!.revenue)).toBeGreaterThan(Number(rows[1]!.revenue))
    expect(Number(top!.unitsSold)).toBeLessThan(Number(rows[1]!.unitsSold))
  })

  it('shows the newest eight events first', () => {
    const rows = computeDashboard(deps()).activity
    expect(rows).toHaveLength(8)
    expect(rows[0]).toMatchObject({
      id: 'sale:3',
      kind: 'SALE',
      title: 'Sale completed',
      detail: 'INV-3',
      amount: '315.00',
    })
    // Standing alerts are stamped at the start of the day, so they sit below
    // today's trading and above yesterday's — which is what falls off the end.
    expect(rows.map((r) => r.kind)).toEqual([
      'SALE', 'SALE', 'SHORTBOOK', 'SALE', 'EXPIRY', 'EXPIRY', 'LOW_STOCK', 'LOW_STOCK',
    ])
    // Ids must survive a refetch so React keys and read-state do not churn.
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  })
})

describe('computeDashboard — determinism', () => {
  it('produces byte-identical output for identical deps', () => {
    const a = computeDashboard(deps())
    const b = computeDashboard(deps())
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('does not depend on the order rows arrive in', () => {
    const forwards = computeDashboard(deps())
    const backwards = computeDashboard(deps({
      invoices: [...INVOICES].reverse(),
      batches: [...BATCHES].reverse(),
      medicines: [...MEDICINES].reverse(),
    }))
    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards))
  })
})


// ------------------------------------------------------------------ ranges ---

/** Trading spread across two seven-day windows either side of 2026-09-02. */
const RANGE_INVOICES: SaleInvoice[] = [
  // inside the selected 7-day window (02 Sep - 08 Sep)
  invoice({
    id: 20,
    invoiceDate: '2026-09-03',
    createdAt: at(3, 11),
    netAmount: '1000.00',
    lines: [{ medicineId: 1, drugSchedule: 'OTC', qty: '20', taxableValue: '900.00', costBasis: '500.00', lineTotal: '1000.00' }],
  }),
  invoice({
    id: 21,
    invoiceDate: TODAY,
    createdAt: at(8, 16),
    netAmount: '200.00',
    lines: [{ medicineId: 2, drugSchedule: 'H', qty: '4', taxableValue: '180.00', costBasis: '120.00', lineTotal: '200.00' }],
  }),
  // inside the comparison window (26 Aug - 01 Sep)
  invoice({
    id: 22,
    invoiceDate: '2026-08-28',
    createdAt: '2026-08-28T05:30:00.000Z',
    netAmount: '400.00',
    lines: [{ medicineId: 1, drugSchedule: 'OTC', qty: '8', taxableValue: '360.00', costBasis: '200.00', lineTotal: '400.00' }],
  }),
  invoice({
    id: 23,
    invoiceDate: '2026-08-30',
    createdAt: '2026-08-30T05:30:00.000Z',
    netAmount: '900.00',
    lines: [{ medicineId: 2, drugSchedule: 'H', qty: '18', taxableValue: '800.00', costBasis: '600.00', lineTotal: '900.00' }],
  }),
]

describe('rangeWindow', () => {
  it('reads a single day against the day before it', () => {
    expect(rangeWindow(TODAY, 'today')).toEqual({
      start: TODAY,
      end: TODAY,
      prevStart: YESTERDAY,
      prevEnd: YESTERDAY,
      days: 1,
      comparedTo: 'yesterday',
    })
  })

  it('compares a week against the week that ended the day before it', () => {
    expect(rangeWindow(TODAY, '7d')).toEqual({
      start: '2026-09-02',
      end: TODAY,
      prevStart: '2026-08-26',
      prevEnd: '2026-09-01',
      days: 7,
      comparedTo: 'previous 7 days',
    })
  })

  it('compares month-to-date against the SAME NUMBER OF DAYS before it', () => {
    // Not against the whole of August: eight days of trading against thirty-one
    // reports a catastrophe every month on the 8th.
    const w = rangeWindow(TODAY, 'month')
    expect(w.start).toBe('2026-09-01')
    expect(w.days).toBe(8)
    expect(w.prevStart).toBe('2026-08-24')
    expect(w.prevEnd).toBe('2026-08-31')
    expect(w.comparedTo).toBe('previous 8 days')
  })

  it('defaults to the single day when no range is named', () => {
    expect(rangeWindow(TODAY)).toEqual(rangeWindow(TODAY, 'today'))
  })
})

describe('computeDashboard — ranged windows', () => {
  it('sums the whole window and compares it against the previous one', () => {
    const d = computeDashboard(deps({ invoices: RANGE_INVOICES, range: '7d' }))
    expect(d.range).toBe('7d')
    expect(d.periodStart).toBe('2026-09-02')
    expect(d.periodEnd).toBe(TODAY)
    expect(d.comparedTo).toBe('previous 7 days')
    expect(d.kpis.sales.value).toBe('1200.00')
    expect(d.kpis.orders.value).toBe('2')
    // 1200 against 1300 is a fall, and the tile must be able to say so.
    expect(d.kpis.sales.deltaPct).toBe('-7.69')
  })

  it('leaves the single-day dashboard exactly as it was', () => {
    const ranged = computeDashboard(deps({ range: 'today' }))
    const plain = computeDashboard(deps())
    expect(JSON.stringify(ranged)).toBe(JSON.stringify(plain))
    expect(plain.range).toBe('today')
    expect(plain.comparedTo).toBe('yesterday')
  })

  it('draws a day for every day in the window, including the ones that took nothing', () => {
    const d = computeDashboard(deps({ invoices: RANGE_INVOICES, range: '7d' }))
    expect(d.periodTrend).toHaveLength(7)
    expect(d.periodTrend.map((p) => p.label)).toEqual([
      '02 Sep', '03 Sep', '04 Sep', '05 Sep', '06 Sep', '07 Sep', '08 Sep',
    ])
    // A shut Sunday is a gap in the line, not a day the chart quietly closes up.
    expect(d.periodTrend.map((p) => p.values['sales'])).toEqual([
      '0.00', '1000.00', '0.00', '0.00', '0.00', '0.00', '200.00',
    ])
  })

  it('keeps the hourly view for a single day', () => {
    const d = computeDashboard(deps({ range: 'today' }))
    expect(d.periodTrend).toEqual(d.todayByHour)
  })
})

describe('computeDashboard — top movers', () => {
  it('ranks by the RUPEE change and separates risers from fallers', () => {
    const d = computeDashboard(deps({ invoices: RANGE_INVOICES, range: '7d' }))
    // Brand 1: 400 -> 1000. Brand 2: 900 -> 200.
    expect(d.topMovers.risers.map((r) => [r.brandName, r.deltaAmount, r.deltaPct]))
      .toEqual([['Brand 1', '600.00', '150.00']])
    expect(d.topMovers.fallers.map((r) => [r.brandName, r.deltaAmount, r.deltaPct]))
      .toEqual([['Brand 2', '-700.00', '-77.78']])
  })

  it('emits a null percentage for a line with no previous period rather than +100%', () => {
    const d = computeDashboard(deps({
      range: '7d',
      invoices: [RANGE_INVOICES[1] as SaleInvoice],
    }))
    expect(d.topMovers.risers).toHaveLength(1)
    expect(d.topMovers.risers[0]?.deltaPct).toBeNull()
    expect(d.topMovers.risers[0]?.current).toBe('200.00')
    expect(d.topMovers.fallers).toEqual([])
  })

  it('says nothing about a line that did not move', () => {
    const flat = [
      invoice({
        id: 30,
        invoiceDate: '2026-09-03',
        createdAt: at(3, 10),
        netAmount: '100.00',
        lines: [{ medicineId: 1, drugSchedule: 'OTC', qty: '2', taxableValue: '90.00', costBasis: '50.00', lineTotal: '100.00' }],
      }),
      invoice({
        id: 31,
        invoiceDate: '2026-08-28',
        createdAt: '2026-08-28T05:30:00.000Z',
        netAmount: '100.00',
        lines: [{ medicineId: 1, drugSchedule: 'OTC', qty: '2', taxableValue: '90.00', costBasis: '50.00', lineTotal: '100.00' }],
      }),
    ]
    const d = computeDashboard(deps({ invoices: flat, range: '7d' }))
    expect(d.topMovers).toEqual({ risers: [], fallers: [] })
  })

  it('is empty on the branch dashboard until the adapter fills it in', () => {
    expect(computeDashboard(deps()).branches).toEqual([])
  })
})

describe('branchComparison', () => {
  const BRANCH: StoreProfile = { ...STORE, id: 2, name: 'Test Medicals — Kothrud', city: 'Kothrud' }

  const CROSS_BRANCH: SaleInvoice[] = [
    ...INVOICES,
    { ...invoice({
      id: 40,
      invoiceDate: TODAY,
      createdAt: at(8, 12),
      netAmount: '500.00',
      lines: [{ medicineId: 1, drugSchedule: 'OTC', qty: '10', taxableValue: '450.00', costBasis: '300.00', lineTotal: '500.00' }],
    }), storeId: 2 },
  ]

  const CROSS_BATCHES: Batch[] = [
    ...BATCHES,
    batch(11, 1, { storeId: 2, expiryDate: '2027-06-30', qtyOnHand: '50.000', landedCostPerUnit: '6.0000' }),
    batch(12, 2, { storeId: 2, expiryDate: '2026-09-20', qtyOnHand: '10.000', landedCostPerUnit: '4.0000' }),
  ]

  const run = () => branchComparison({
    stores: [STORE, BRANCH],
    invoices: CROSS_BRANCH,
    batches: CROSS_BATCHES,
    currentStoreId: 1,
    from: TODAY,
    to: TODAY,
    today: TODAY,
  })

  it('scopes takings to the branch that took them', () => {
    const [head, branch] = run()
    // The head shop's three bills, and the branch's one — never each other's.
    expect(head?.sales).toBe('630.00')
    expect(head?.orders).toBe(3)
    expect(branch?.sales).toBe('500.00')
    expect(branch?.orders).toBe(1)
  })

  it('marks the branch this session is billing for', () => {
    expect(run().map((b) => b.isCurrent)).toEqual([true, false])
  })

  it('values each shelf separately, at landed cost', () => {
    const [, branch] = run()
    // 50 x 6.00 sellable, plus 10 x 4.00 that expires inside the window.
    expect(branch?.stockAtCost).toBe('340.00')
    expect(branch?.batches).toBe(2)
    expect(branch?.nearExpiry).toBe(1)
  })
})
