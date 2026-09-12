import { describe, expect, it } from 'vitest'
import type { Medicine } from '@contract'
import {
  buildRows, detectDelimiter, guessColumns, learnedAliases, matchItem, missingRequired,
  normaliseName, parseSheet, readiness, splitRow, toPurchaseLines,
} from './importer'
import type { ColumnMap, MatchContext } from './importer'

/**
 * The importer is the strongest switching lever the product has, and every one
 * of these tests is a way a real distributor file breaks it.
 */

function medicine(id: number, brandName: string, over: Partial<Medicine> = {}): Medicine {
  return {
    id,
    storeId: 1,
    brandName,
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
    drugSchedule: 'H',
    requiresPrescription: true,
    rackLocation: 'A1',
    reorderLevel: 100,
    saleRank: 0,
    isActive: true,
    ...over,
  }
}

const CATALOGUE = [
  medicine(1, 'Dolo 650'),
  medicine(2, 'Calpol 500'),
  medicine(3, 'Amoxycillin 500'),
  medicine(4, 'Pan 40'),
]

const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({
  medicines: CATALOGUE,
  barcodes: new Map([['8901234567890', 2]]),
  aliases: new Map(),
  packMrps: new Map(),
  ...over,
})

// --------------------------------------------------------------- delimiter ---

describe('reading the file', () => {
  it('picks the delimiter that splits every line EVENLY, not the commonest one', () => {
    // Product names carry commas. By raw frequency this file is comma-delimited
    // and every name would split into three columns.
    const tsv = [
      'Product\tBatch\tQty',
      'Vitamin B1, B6, B12\tA1\t10',
      'Calcium, Magnesium\tA2\t5',
    ].join('\n')
    expect(detectDelimiter(tsv)).toBe('\t')
  })

  it('handles quoting three ways, because exporters do', () => {
    expect(splitRow('a,b,c', ',')).toEqual(['a', 'b', 'c'])
    expect(splitRow('"a","b, still b","c"', ',')).toEqual(['a', 'b, still b', 'c'])
    expect(splitRow('a,"He said ""hi""",c', ',')).toEqual(['a', 'He said "hi"', 'c'])
  })

  it('finds the header BELOW the letterhead a distributor puts on top', () => {
    const text = [
      'SANJIVANI PHARMA DISTRIBUTORS',
      'GSTIN: 27AACCS4471M1ZB',
      'Invoice: SPD/4471',
      'Product,Batch,Exp,Qty,MRP,Rate',
      'Dolo 650,B1,11/27,10,150.00,110.00',
    ].join('\n')
    const sheet = parseSheet(text)
    expect(sheet.headers).toEqual(['Product', 'Batch', 'Exp', 'Qty', 'MRP', 'Rate'])
    expect(sheet.rows).toHaveLength(1)
  })

  it('pads a short row but REFUSES a long one', () => {
    // Trailing empties are routinely omitted; an over-long row is genuinely
    // misaligned and trimming it would put the discount in the GST column.
    const text = [
      'Product,Batch,Exp,Qty,MRP,Rate',
      'Dolo 650,B1,11/27,10',
      'Pan 40,B2,11/27,10,150.00,110.00,EXTRA',
    ].join('\n')
    const sheet = parseSheet(text)
    expect(sheet.rows).toHaveLength(1)
    expect(sheet.rows[0]).toHaveLength(6)
    expect(sheet.ragged).toBe(1)
  })
})

// ----------------------------------------------------------------- columns ---

describe('guessing the columns', () => {
  it('gives MRP the "MRP RATE" header, not the rate column', () => {
    // Both patterns match this header. Getting it backwards prices every batch
    // at cost, and the bill still posts cleanly.
    const map = guessColumns(['ITEM NAME', 'BATCH', 'EXP', 'QTY', 'MRP RATE', 'PTR'])
    expect(map.mrpPerPack).toBe(4)
    expect(map.ratePerPack).toBe(5)
  })

  it('reads the spellings distributors actually use', () => {
    const map = guessColumns([
      'PARTICULARS', 'B.NO', 'EXP DT', 'QNTY', 'FREE', 'M.R.P', 'BASIC', 'DIS%', 'GST%', 'HSN CODE',
    ])
    expect(map).toMatchObject({
      name: 0, batchNo: 1, expiry: 2, qtyPacks: 3, freePacks: 4,
      mrpPerPack: 5, ratePerPack: 6, discountPct: 7, gstRatePct: 8, hsnCode: 9,
    })
  })

  it('names what is missing rather than posting a line that is not one', () => {
    expect(missingRequired(guessColumns(['ITEM', 'QTY']))).toEqual(
      ['batchNo', 'expiry', 'mrpPerPack', 'ratePerPack'],
    )
  })
})

// ---------------------------------------------------------------- matching ---

describe('matching an item', () => {
  it('strips pack notation and dosage so a distributor name meets ours', () => {
    expect(normaliseName('DOLO 650 TAB.')).toBe(normaliseName('Dolo 650'))
    expect(normaliseName('PAN-40  10x10')).toBe(normaliseName('Pan 40'))
  })

  it('takes a barcode as identity, ahead of every name', () => {
    const m = matchItem('SOMETHING ELSE ENTIRELY', '8901234567890', ctx())
    expect(m.kind).toBe('barcode')
    expect(m.medicineId).toBe(2)
  })

  it('remembers a decision already made — this is what makes import two fast', () => {
    const aliases = new Map([[normaliseName('DOLOWIN 650'), 1]])
    const m = matchItem('DOLOWIN 650', undefined, ctx({ aliases }))
    expect(m.kind).toBe('alias')
    expect(m.medicineId).toBe(1)
  })

  it('REFUSES to choose between two products whose names collide', () => {
    // Same brand at two strengths is the usual cause, and picking one silently
    // puts the stock on the wrong SKU at the wrong MRP.
    const twins = [medicine(9, 'Zerodol SP'), medicine(10, 'Zerodol-SP')]
    const m = matchItem('ZERODOL SP', undefined, ctx({ medicines: twins }))
    expect(m.kind).toBe('ambiguous')
    expect(m.medicineId).toBeNull()
    expect(m.candidates).toHaveLength(2)
  })


  it('separates four pack sizes of ONE brand by the MRP on the bill', () => {
    // The commonest ambiguity there is, and the one that makes an operator
    // hand-pick a pack on nearly every line. The name cannot tell them apart;
    // the bill's MRP per pack can.
    const packs = [
      medicine(20, 'Dolo 650', { packLabel: '1x10', unitsPerPack: 10 }),
      medicine(21, 'Dolo 650', { packLabel: '1x15', unitsPerPack: 15 }),
      medicine(22, 'Dolo 650', { packLabel: '10x10', unitsPerPack: 100 }),
    ]
    const packMrps = new Map<number, ReadonlySet<string>>([
      [20, new Set(['30.00'])],
      [21, new Set(['45.00'])],
      [22, new Set(['300.00'])],
    ])
    const m = matchItem('DOLO 650 TAB', undefined, ctx({ medicines: packs, packMrps }), '45.00')
    expect(m.kind).toBe('mrp')
    expect(m.medicineId).toBe(21)
  })

  it('compares the MRP as money, not as text', () => {
    // A distributor writes 1500, 1500.00 and "1,500.00" for the same money.
    const packs = [medicine(30, 'Pan 40', { packLabel: '1x15' }), medicine(31, 'Pan 40', { packLabel: '10x10' })]
    const packMrps = new Map<number, ReadonlySet<string>>([
      [30, new Set(['1500.00'])],
      [31, new Set(['200.00'])],
    ])
    for (const written of ['1500', '1500.00', '1,500.00']) {
      const m = matchItem('PAN 40', undefined, ctx({ medicines: packs, packMrps }), written)
      expect(m.medicineId, written).toBe(30)
    }
  })

  it('still refuses when two packs share an MRP', () => {
    const packs = [medicine(40, 'Pan 40', { packLabel: '1x15' }), medicine(41, 'Pan 40', { packLabel: '15x1' })]
    const packMrps = new Map<number, ReadonlySet<string>>([
      [40, new Set(['200.00'])],
      [41, new Set(['200.00'])],
    ])
    const m = matchItem('PAN 40', undefined, ctx({ medicines: packs, packMrps }), '200.00')
    expect(m.kind).toBe('ambiguous')
    expect(m.medicineId).toBeNull()
  })

  it('narrows only — an MRP nothing was received at changes nothing', () => {
    const packs = [medicine(50, 'Pan 40', { packLabel: '1x15' }), medicine(51, 'Pan 40', { packLabel: '10x10' })]
    const packMrps = new Map<number, ReadonlySet<string>>([[50, new Set(['200.00'])]])
    // A new pack MRP is a price revision, not a reason to drop every candidate.
    const m = matchItem('PAN 40', undefined, ctx({ medicines: packs, packMrps }), '999.00')
    expect(m.kind).toBe('ambiguous')
    expect(m.candidates).toHaveLength(2)
  })

  it('suggests but never applies a fuzzy hit', () => {
    const m = matchItem('AMOXYCILLIN 500 CAP TRIHYDRATE', undefined, ctx())
    expect(m.kind).toBe('fuzzy')
    expect(m.medicineId).toBeNull()
    expect(m.candidates.map((c) => c.id)).toContain(3)
  })


  it('does NOT claim an MRP match it did not earn', () => {
    // One fuzzy candidate and no MRP evidence at all. Returning "matched by MRP"
    // here would turn a suggestion into a decision without anybody confirming it.
    const m = matchItem('AMOXYCILLIN 500 CAP TRIHYDRATE', undefined, ctx(), '90.00')
    expect(m.kind).toBe('fuzzy')
    expect(m.medicineId).toBeNull()
  })

  it('offers nothing at all for a stub — forty candidates is not a suggestion', () => {
    expect(matchItem('CAL', undefined, ctx()).kind).toBe('new')
  })
})

// -------------------------------------------------------------------- rows ---

describe('building the lines', () => {
  const FILE = [
    'PARTICULARS,B.NO,EXP DT,QNTY,FREE,M.R.P,RATE,DIS%,GST%,HSN',
    'DOLO 650 TAB,B1,11/27,10,1,"1,500.00","1,100.00",5,12,30049099',
    'MYSTERY BRAND,B2,11/27,4,0,90.00,60.00,0,12,30049099',
  ].join('\n')

  const sheet = parseSheet(FILE)
  const map: ColumnMap = guessColumns(sheet.headers)

  it('strips currency and digit grouping out of a distributor cell', () => {
    const rows = buildRows(sheet, map, ctx())
    expect(rows[0]?.line.ratePerPack).toBe('1100.00')
  })

  it('carries free quantity, which is the landed-cost denominator', () => {
    const rows = buildRows(sheet, map, ctx())
    expect(rows[0]?.line.freePacks).toBe('1')
  })

  it('flags a rate above MRP as a MAPPING error, where it can still be fixed', () => {
    const swapped = [
      'ITEM,BATCH,EXP,QTY,RATE,MRP',
      'Dolo 650,B1,11/27,10,150.00,110.00',
    ].join('\n')
    const s = parseSheet(swapped)
    const rows = buildRows(s, guessColumns(s.headers), ctx())
    expect(rows[0]?.problems.join(' ')).toMatch(/right way round/)
  })

  it('will not post while a single line is undecided', () => {
    const rows = buildRows(sheet, map, ctx())
    const state = readiness(rows, map)
    expect(state.unresolved).toBe(1)
    expect(state.canPost).toBe(false)
  })

  it('posts once the last line is decided, and only the decided ones', () => {
    const rows = buildRows(sheet, map, ctx())
    const resolved = rows.map((r) => (r.medicineId === null ? { ...r, medicineId: 4 } : r))
    const state = readiness(resolved, map)
    expect(state.canPost).toBe(true)

    const lines = toPurchaseLines(resolved)
    expect(lines).toHaveLength(2)
    expect(lines[0]?.medicineId).toBe(1)
    expect(lines[1]?.medicineId).toBe(4)
    expect(lines.map((l) => l.lineId)).toEqual(['i1', 'i2'])
  })

  it('skipping a line excludes it, out loud', () => {
    const rows = buildRows(sheet, map, ctx())
    const skipped = rows.map((r) => (r.medicineId === null ? { ...r, skipped: true } : r))
    const state = readiness(skipped, map)
    expect(state.canPost).toBe(true)
    expect(state.skipped).toBe(1)
    expect(toPurchaseLines(skipped)).toHaveLength(1)
  })

  it('WARNS about a pre-GST layout instead of silently leaving the HSN blank', () => {
    // The research names this exactly: standard formats predate GST, carry no
    // HSN column, import cleanly, and surface months later as an unfilable
    // return.
    const old = ['ITEM,BATCH,EXP,QTY,MRP,RATE', 'Dolo 650,B1,11/27,10,150.00,110.00'].join('\n')
    const s = parseSheet(old)
    const state = readiness(buildRows(s, guessColumns(s.headers), ctx()), guessColumns(s.headers))
    expect(state.warnings.join(' ')).toMatch(/No HSN column/)
    expect(state.warnings.join(' ')).toMatch(/free-quantity column/)
    // A warning, never a block: the bill is still importable.
    expect(state.canPost).toBe(true)
  })
})

// ---------------------------------------------------------------- learning ---

describe('what the import teaches the next one', () => {
  const FILE = [
    'ITEM,BATCH,EXP,QTY,MRP,RATE',
    'DOLO 650 TAB,B1,11/27,10,150.00,110.00',
    'MYSTERY BRAND,B2,11/27,4,90.00,60.00',
  ].join('\n')
  const sheet = parseSheet(FILE)
  const map = guessColumns(sheet.headers)

  it('records the operator\'s decision so the next bill matches without asking', () => {
    const rows = buildRows(sheet, map, ctx())
      .map((r) => (r.medicineId === null ? { ...r, medicineId: 4 } : r))
    const learned = learnedAliases(rows)
    expect(learned.get(normaliseName('MYSTERY BRAND'))).toBe(4)

    // And it does: the same file, imported again, resolves on its own.
    const second = buildRows(sheet, map, ctx({ aliases: learned }))
    expect(second.every((r) => r.medicineId !== null)).toBe(true)
    expect(second[1]?.match.kind).toBe('alias')
  })

  it('learns nothing from a barcode or from a row it was already taught', () => {
    const rows = buildRows(sheet, map, ctx({ aliases: new Map([[normaliseName('DOLO 650 TAB'), 1]]) }))
      .map((r) => (r.medicineId === null ? { ...r, medicineId: 4 } : r))
    const learned = learnedAliases(rows)
    expect(learned.has(normaliseName('DOLO 650 TAB'))).toBe(false)
  })

  it('learns nothing from a line that was skipped', () => {
    const rows = buildRows(sheet, map, ctx()).map((r) => ({ ...r, skipped: true }))
    expect(learnedAliases(rows).size).toBe(0)
  })
})
