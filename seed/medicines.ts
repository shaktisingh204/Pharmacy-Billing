/**
 * Demo medicine master and opening stock.
 *
 * DEMO DATA — brand/manufacturer pairings, prices, HSN codes and schedule
 * classifications are development approximations, NOT an authoritative drug
 * database. See seed/README.md and docs/UNVERIFIED.md before using any of it
 * for a real store.
 *
 * Rows are expanded deterministically from a curated brand table under a
 * fixed-seed PRNG. `Math.random()` would make every screenshot, fixture and
 * search-ranking test irreproducible, so it is never used here.
 *
 * Money is emitted as decimal STRINGS. Arithmetic happens on scaled integers
 * inside this file; no float ever reaches an emitted field.
 */

import type {
  BaseUom,
  Batch,
  DosageForm,
  DrugSchedule,
  IsoDate,
  Medicine,
  Money,
  Pct,
  Qty,
} from '../contract/types'

export interface SeedMedicine extends Omit<Medicine, 'id' | 'storeId' | 'saleRank' | 'isActive'> {
  /** Empty for the majority: most Indian strips carry no scannable EAN at all. */
  barcodes: string[]
  saleRank: number
}

// ------------------------------------------------------------------- prng ---

/** mulberry32 — small, fast, and the only property that matters here: seeded. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rnd: () => number, xs: readonly T[]): T | undefined {
  return xs[Math.floor(rnd() * xs.length)]
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

// ------------------------------------------------------------------ money ---

/**
 * Render a scaled integer as a fixed-point string. `.toFixed()` is banned
 * project-wide (I1) and would be wrong anyway: it rounds ties to even.
 */
function fixed(scaled: number, dp: number): Money {
  const s = String(Math.abs(scaled)).padStart(dp + 1, '0')
  const cut = s.length - dp
  return `${scaled < 0 ? '-' : ''}${s.slice(0, cut)}.${s.slice(cut)}`
}

/**
 * Rupees to an integer count of 10^dp. Every value here is positive, so
 * `Math.round` is half-up, which is half-away-from-zero.
 */
function scaleUp(rupees: number, dp: number): number {
  return Math.round(rupees * 10 ** dp)
}

// -------------------------------------------------------------- barcodes ----

/**
 * EAN-13 check digit: positions 1..12 weighted 1,3,1,3… The digit is COMPUTED,
 * never invented — a scanner rejects a bad one and the barcode path would look
 * broken for reasons that have nothing to do with the app.
 */
function ean13(body12: string): string {
  let sum = 0
  for (let i = 0; i < 12; i++) {
    const d = body12.charCodeAt(i) - 48
    sum += i % 2 === 0 ? d : d * 3
  }
  return `${body12}${(10 - (sum % 10)) % 10}`
}

// --------------------------------------------------------------- calendar ---

/** Printed expiry is a MONTH; the stock is good to its last day (I7 keys on it). */
function endOfMonth(year: number, month0: number): IsoDate {
  const d = new Date(Date.UTC(year, month0 + 1, 0))
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${m}-${day}`
}

function daysBetween(from: Date, isoDate: IsoDate): number {
  const base = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
  const [y, m, d] = isoDate.split('-')
  const target = Date.UTC(Number(y), Number(m) - 1, Number(d))
  return Math.round((target - base) / 86_400_000)
}

// ------------------------------------------------------------ brand table ---

/**
 * HSN is a tariff heading, not a therapeutic class. These are the headings a
 * retail pharmacy actually keys, but every one of them is UNVERIFIED against
 * the tariff schedule — see docs/UNVERIFIED.md.
 */
const HSN = {
  ALLOPATHIC: '30049099',
  ANTIBIOTIC: '30042099',
  PENICILLIN: '30041099',
  CORTICOSTEROID: '30043290',
  INSULIN: '30043190',
  VITAMIN: '30045090',
  AYURVEDIC: '30049011',
  ORS: '30049069',
  NUTRACEUTICAL: '21069099',
  BULK: '30039090',
  BULK_ANTIBIOTIC: '30032000',
  ADHESIVE_DRESSING: '30051010',
  DRESSING: '30059090',
  COSMETIC: '33049990',
  DIAGNOSTIC: '38221900',
  INSTRUMENT: '90189019',
  SYRINGE: '90183100',
  THERMOMETER: '90251110',
} as const

/**
 * Purchase-side GST by heading. The OUTPUT rate is resolved from the invoice
 * date (I8) and never from here; this is only what the batch was BOUGHT at.
 */
const GST_BY_HSN: Record<string, Pct> = {
  [HSN.ORS]: '0',
  [HSN.NUTRACEUTICAL]: '18',
  [HSN.COSMETIC]: '18',
  [HSN.THERMOMETER]: '18',
  [HSN.DIAGNOSTIC]: '12',
  [HSN.INSTRUMENT]: '12',
  [HSN.SYRINGE]: '12',
  [HSN.ADHESIVE_DRESSING]: '12',
  [HSN.DRESSING]: '12',
}

/** Total, so the printed rate and the arithmetic that strips it cannot drift apart. */
function gstDivisor(pct: Pct): number {
  return pct === '0' ? 1 : pct === '12' ? 1.12 : pct === '18' ? 1.18 : 1.05
}

interface PackSpec {
  /** As printed on the carton. "10x10" is ten strips; the SALE pack is one strip. */
  readonly label: string
  /** Base units in ONE sale pack. */
  readonly units: number
  /** Pack MRP relative to the reference pack. Carries bottle/tube size. */
  readonly f: number
}

function pack(label: string, units: number, f = 1): PackSpec {
  return { label, units, f }
}

interface StrengthSpec {
  readonly s: string
  /** Full composition. Combination products differ per strength. */
  readonly c: string
  /** Label suffix when it is not the strength itself: "Telma H 40", not "…40mg+12.5mg". */
  readonly n?: string
}

function variant(s: string, c: string, n?: string): StrengthSpec {
  return n === undefined ? { s, c } : { s, c, n }
}

interface BrandSpec {
  readonly brand: string
  readonly generic: string | null
  readonly mfr: string
  /** `{}` takes the strength. Defaults to "<generic> {}". */
  readonly salt?: string
  /** strengths[0] is the flagship: it carries the full saleRank. */
  readonly strengths: readonly (string | StrengthSpec)[]
  /** MRP per base unit, in rupees, for strengths[0] at the reference pack. */
  readonly ppu: number
  /** 90-day dispense count for the flagship SKU. Search ranking is driven by it. */
  readonly rank: number
  readonly form?: DosageForm
  readonly sched?: DrugSchedule
  readonly hsn?: string
  readonly packs?: readonly PackSpec[]
  readonly uom?: BaseUom
  readonly loose?: boolean
  /** Half-tablet dispensing, where it is genuinely routine. */
  readonly step?: Qty
  readonly cold?: boolean
}

const TABLET_PACKS = [
  pack('1x10', 10), pack('1x15', 15), pack('10x10', 10),
  pack('1x30', 30), pack('3x10', 10), pack('10x15', 15),
] as const
const CAPSULE_PACKS = [pack('1x10', 10), pack('10x10', 10), pack('1x15', 15), pack('3x10', 10)] as const
const SYRUP_PACKS = [pack('100ml', 1), pack('60ml', 1, 0.66), pack('200ml', 1, 1.85), pack('30ml', 1, 0.38)] as const
const DROP_PACKS = [pack('10ml', 1), pack('15ml', 1, 1.4), pack('5ml', 1, 0.58)] as const
// The five-ampoule carton is FIVE base units. Left at 1 it would put the whole
// carton's MRP on `mrpPerUnit` and charge five ampoules for a dispensed one.
const INJECTION_PACKS = [pack('1 vial', 1), pack('2ml amp', 1, 0.9), pack('5x2ml amp', 5, 0.84)] as const
const OINTMENT_PACKS = [pack('15g tube', 1), pack('30g tube', 1, 1.8), pack('10g tube', 1, 0.72)] as const
const INHALER_PACKS = [pack('200 MD', 1), pack('120 MD', 1, 0.68)] as const
const POWDER_PACKS = [pack('100g jar', 1), pack('200g jar', 1, 1.85)] as const
const SACHET_PACKS = [pack('1 sachet', 1), pack('10 sachets', 10)] as const
const UNIT_PACKS = [pack('1 unit', 1)] as const
const SURGICAL_PACKS = [pack('1 pack', 1), pack('5 pcs', 5)] as const

const DEFAULT_PACKS: Record<DosageForm, readonly PackSpec[]> = {
  Tablet: TABLET_PACKS,
  Capsule: CAPSULE_PACKS,
  Syrup: SYRUP_PACKS,
  Injection: INJECTION_PACKS,
  Ointment: OINTMENT_PACKS,
  Drops: DROP_PACKS,
  Inhaler: INHALER_PACKS,
  Powder: POWDER_PACKS,
  Sachet: SACHET_PACKS,
  Device: UNIT_PACKS,
  Surgical: SURGICAL_PACKS,
  Other: UNIT_PACKS,
}

const DEFAULT_UOM: Record<DosageForm, BaseUom> = {
  Tablet: 'TAB',
  Capsule: 'CAP',
  Syrup: 'BOTTLE',
  Injection: 'VIAL',
  Ointment: 'TUBE',
  Drops: 'BOTTLE',
  Inhaler: 'UNIT',
  Powder: 'UNIT',
  Sachet: 'UNIT',
  Device: 'UNIT',
  Surgical: 'UNIT',
  Other: 'UNIT',
}

const AZITHRO_PACKS = [pack('1x5', 5), pack('1x3', 3), pack('1x10', 10)] as const
const CLAV_PACKS = [pack('1x10', 10), pack('1x6', 6), pack('1x15', 15)] as const
const SINGLE_TAB = [pack('1x1', 1)] as const
const VIAL_ONLY = [pack('1 vial', 1)] as const
const THYROID_PACKS = [pack('1x100 bottle', 100), pack('1x120 bottle', 120, 1.2), pack('1x30', 30, 0.31)] as const

/**
 * The curated base list. Everything downstream is a deterministic expansion of
 * these rows across strength and pack, so this table is the only place to edit.
 */
const BRANDS: readonly BrandSpec[] = [
  // --- analgesics, antipyretics, antispasmodics ---
  { brand: 'Dolo', generic: 'Paracetamol', mfr: 'Micro Labs', sched: 'OTC', ppu: 2.05, rank: 2600, strengths: ['650mg', '500mg'] },
  { brand: 'Crocin Advance', generic: 'Paracetamol', mfr: 'GSK', sched: 'OTC', ppu: 1.95, rank: 780, strengths: ['500mg', '650mg'] },
  { brand: 'Calpol', generic: 'Paracetamol', mfr: 'GSK', sched: 'OTC', ppu: 1.9, rank: 620, strengths: ['650mg', '500mg'] },
  { brand: 'Calpol 120', generic: 'Paracetamol', mfr: 'GSK', sched: 'OTC', form: 'Syrup', ppu: 46, rank: 340, strengths: ['120mg/5ml'] },
  { brand: 'Combiflam', generic: 'Ibuprofen + Paracetamol', mfr: 'Sanofi', sched: 'OTC', ppu: 2.4, rank: 1100, strengths: [variant('400mg+325mg', 'Ibuprofen 400mg + Paracetamol 325mg')] },
  { brand: 'Brufen', generic: 'Ibuprofen', mfr: 'Abbott', ppu: 1.6, rank: 260, strengths: ['400mg', '600mg', '200mg'] },
  { brand: 'Zerodol SP', generic: 'Aceclofenac + Paracetamol + Serratiopeptidase', mfr: 'Ipca', ppu: 9.8, rank: 1450, strengths: [variant('100mg+325mg+15mg', 'Aceclofenac 100mg + Paracetamol 325mg + Serratiopeptidase 15mg')] },
  { brand: 'Zerodol P', generic: 'Aceclofenac + Paracetamol', mfr: 'Ipca', ppu: 7.4, rank: 900, strengths: [variant('100mg+325mg', 'Aceclofenac 100mg + Paracetamol 325mg')] },
  { brand: 'Zerodol MR', generic: 'Aceclofenac + Paracetamol + Chlorzoxazone', mfr: 'Ipca', ppu: 10.2, rank: 420, strengths: [variant('100mg+325mg+250mg', 'Aceclofenac 100mg + Paracetamol 325mg + Chlorzoxazone 250mg')] },
  { brand: 'Hifenac', generic: 'Aceclofenac', mfr: 'Intas', ppu: 6.2, rank: 300, strengths: ['100mg'] },
  { brand: 'Hifenac P', generic: 'Aceclofenac + Paracetamol', mfr: 'Intas', ppu: 8.1, rank: 250, strengths: [variant('100mg+325mg', 'Aceclofenac 100mg + Paracetamol 325mg')] },
  { brand: 'Nise', generic: 'Nimesulide', mfr: "Dr Reddy's", ppu: 3.6, rank: 380, strengths: ['100mg'] },
  { brand: 'Voveran', generic: 'Diclofenac Sodium', mfr: 'Novartis', ppu: 2.9, rank: 340, strengths: ['50mg'] },
  { brand: 'Voveran SR', generic: 'Diclofenac Sodium', mfr: 'Novartis', ppu: 5.1, rank: 280, strengths: ['100mg'] },
  { brand: 'Dolonex', generic: 'Piroxicam', mfr: 'Pfizer', ppu: 8.5, rank: 130, strengths: ['20mg'] },
  { brand: 'Ultracet', generic: 'Tramadol + Paracetamol', mfr: 'Janssen', sched: 'H1', ppu: 14, rank: 260, strengths: [variant('37.5mg+325mg', 'Tramadol 37.5mg + Paracetamol 325mg')] },
  { brand: 'Tramazac', generic: 'Tramadol', mfr: 'Zydus', sched: 'H1', ppu: 6.5, rank: 90, strengths: ['50mg', '100mg'] },
  { brand: 'Meftal Spas', generic: 'Mefenamic Acid + Dicyclomine', mfr: 'Blue Cross', ppu: 6.4, rank: 820, strengths: [variant('250mg+10mg', 'Mefenamic Acid 250mg + Dicyclomine 10mg')] },
  { brand: 'Meftal Forte', generic: 'Mefenamic Acid', mfr: 'Blue Cross', ppu: 4.1, rank: 240, strengths: ['500mg'] },
  { brand: 'Cyclopam', generic: 'Dicyclomine + Paracetamol', mfr: 'Indoco', ppu: 4.8, rank: 560, strengths: [variant('20mg+500mg', 'Dicyclomine 20mg + Paracetamol 500mg')] },
  { brand: 'Drotin', generic: 'Drotaverine', mfr: 'Walter Bushnell', ppu: 8.2, rank: 210, strengths: ['40mg', '80mg'] },
  { brand: 'Drotin M', generic: 'Drotaverine + Mefenamic Acid', mfr: 'Walter Bushnell', ppu: 12, rank: 180, strengths: [variant('80mg+250mg', 'Drotaverine 80mg + Mefenamic Acid 250mg')] },
  { brand: 'Etoshine', generic: 'Etoricoxib', mfr: 'Sun Pharma', ppu: 11.5, rank: 300, strengths: ['90mg', '60mg', '120mg'] },
  { brand: 'Nucoxia', generic: 'Etoricoxib', mfr: 'Zydus', ppu: 10.8, rank: 210, strengths: ['90mg', '60mg'] },
  { brand: 'Naprosyn', generic: 'Naproxen', mfr: 'Sun Pharma', ppu: 9.2, rank: 90, strengths: ['250mg', '500mg'] },
  { brand: 'Flexon', generic: 'Ibuprofen + Paracetamol', mfr: 'Aristo', sched: 'OTC', ppu: 2.1, rank: 300, strengths: [variant('400mg+325mg', 'Ibuprofen 400mg + Paracetamol 325mg')] },
  { brand: 'Sumo', generic: 'Nimesulide + Paracetamol', mfr: 'Alkem', ppu: 5.6, rank: 260, strengths: [variant('100mg+325mg', 'Nimesulide 100mg + Paracetamol 325mg')] },
  { brand: 'Spasmonil', generic: 'Dicyclomine + Paracetamol', mfr: 'Cipla', ppu: 4.3, rank: 190, strengths: [variant('10mg+325mg', 'Dicyclomine 10mg + Paracetamol 325mg')] },
  { brand: 'Enzoflam', generic: 'Aceclofenac + Paracetamol + Serratiopeptidase', mfr: 'Alkem', ppu: 9.4, rank: 230, strengths: [variant('100mg+325mg+15mg', 'Aceclofenac 100mg + Paracetamol 325mg + Serratiopeptidase 15mg')] },
  { brand: 'Chymoral Forte', generic: 'Trypsin + Chymotrypsin', mfr: 'Torrent', ppu: 13.5, rank: 140, strengths: [variant('100000 AU', 'Trypsin + Chymotrypsin 100000 Armour Units')] },

  // --- antibacterials ---
  { brand: 'Azithral', generic: 'Azithromycin', mfr: 'Alembic', hsn: HSN.ANTIBIOTIC, packs: AZITHRO_PACKS, ppu: 25, rank: 1350, strengths: ['500mg', '250mg'] },
  { brand: 'Azee', generic: 'Azithromycin', mfr: 'Cipla', hsn: HSN.ANTIBIOTIC, packs: AZITHRO_PACKS, ppu: 24, rank: 620, strengths: ['500mg', '250mg'] },
  { brand: 'Zithrox', generic: 'Azithromycin', mfr: 'FDC', hsn: HSN.ANTIBIOTIC, packs: AZITHRO_PACKS, ppu: 22, rank: 180, strengths: ['500mg', '250mg'] },
  { brand: 'Azithral 200', generic: 'Azithromycin', mfr: 'Alembic', hsn: HSN.ANTIBIOTIC, form: 'Syrup', packs: [pack('15ml', 1), pack('30ml', 1, 1.8)], ppu: 82, rank: 260, strengths: ['200mg/5ml'] },
  { brand: 'Augmentin', generic: 'Amoxycillin + Clavulanic Acid', mfr: 'GSK', hsn: HSN.PENICILLIN, packs: CLAV_PACKS, ppu: 19.5, rank: 940, strengths: [variant('625mg', 'Amoxycillin 500mg + Clavulanic Acid 125mg', '625'), variant('375mg', 'Amoxycillin 250mg + Clavulanic Acid 125mg', '375'), variant('1g', 'Amoxycillin 875mg + Clavulanic Acid 125mg', '1g')] },
  { brand: 'Clavam', generic: 'Amoxycillin + Clavulanic Acid', mfr: 'Alkem', hsn: HSN.PENICILLIN, packs: CLAV_PACKS, ppu: 17.5, rank: 520, strengths: [variant('625mg', 'Amoxycillin 500mg + Clavulanic Acid 125mg', '625'), variant('375mg', 'Amoxycillin 250mg + Clavulanic Acid 125mg', '375')] },
  { brand: 'Moxikind CV', generic: 'Amoxycillin + Clavulanic Acid', mfr: 'Mankind', hsn: HSN.PENICILLIN, packs: CLAV_PACKS, ppu: 16, rank: 380, strengths: [variant('625mg', 'Amoxycillin 500mg + Clavulanic Acid 125mg', '625')] },
  { brand: 'Mox', generic: 'Amoxycillin', mfr: 'Sun Pharma', hsn: HSN.PENICILLIN, form: 'Capsule', ppu: 6.4, rank: 300, strengths: ['500mg', '250mg'] },
  { brand: 'Novamox', generic: 'Amoxycillin', mfr: 'Cipla', hsn: HSN.PENICILLIN, form: 'Capsule', ppu: 6.2, rank: 220, strengths: ['500mg', '250mg'] },
  { brand: 'Ampilox', generic: 'Ampicillin + Cloxacillin', mfr: 'Cipla', hsn: HSN.PENICILLIN, form: 'Capsule', ppu: 8.5, rank: 60, strengths: [variant('250mg+250mg', 'Ampicillin 250mg + Cloxacillin 250mg')] },
  { brand: 'Taxim-O', generic: 'Cefixime', mfr: 'Alkem', sched: 'H1', hsn: HSN.ANTIBIOTIC, ppu: 24, rank: 640, strengths: ['200mg', '100mg'] },
  { brand: 'Zifi', generic: 'Cefixime', mfr: 'FDC', sched: 'H1', hsn: HSN.ANTIBIOTIC, ppu: 23, rank: 420, strengths: ['200mg', '100mg'] },
  { brand: 'Mahacef', generic: 'Cefixime', mfr: 'Mankind', sched: 'H1', hsn: HSN.ANTIBIOTIC, ppu: 21, rank: 190, strengths: ['200mg', '100mg'] },
  { brand: 'Monocef', generic: 'Ceftriaxone', mfr: 'Aristo', sched: 'H1', hsn: HSN.ANTIBIOTIC, form: 'Injection', packs: VIAL_ONLY, ppu: 62, rank: 150, strengths: ['1g', '500mg', '250mg'] },
  { brand: 'Omnatax', generic: 'Cefotaxime', mfr: 'Alkem', sched: 'H1', hsn: HSN.ANTIBIOTIC, form: 'Injection', packs: VIAL_ONLY, ppu: 48, rank: 70, strengths: ['1g', '500mg'] },
  { brand: 'Ceftum', generic: 'Cefuroxime', mfr: 'GSK', sched: 'H1', hsn: HSN.ANTIBIOTIC, ppu: 42, rank: 130, strengths: ['500mg', '250mg'] },
  { brand: 'Zocef', generic: 'Cefuroxime', mfr: 'FDC', sched: 'H1', hsn: HSN.ANTIBIOTIC, ppu: 36, rank: 90, strengths: ['500mg', '250mg'] },
  { brand: 'Meronem', generic: 'Meropenem', mfr: 'Pfizer', sched: 'H1', hsn: HSN.ANTIBIOTIC, form: 'Injection', packs: VIAL_ONLY, ppu: 1650, rank: 12, strengths: ['1g', '500mg'] },
  { brand: 'Meropen', generic: 'Meropenem', mfr: 'Hetero', sched: 'H1', hsn: HSN.ANTIBIOTIC, form: 'Injection', packs: VIAL_ONLY, ppu: 620, rank: 18, strengths: ['1g', '500mg'] },
  { brand: 'Metrogyl', generic: 'Metronidazole', mfr: 'JB Chemicals', hsn: HSN.ANTIBIOTIC, ppu: 1.7, rank: 420, strengths: ['400mg', '200mg'] },
  { brand: 'Flagyl', generic: 'Metronidazole', mfr: 'Abbott', hsn: HSN.ANTIBIOTIC, ppu: 2.1, rank: 210, strengths: ['400mg', '200mg'] },
  { brand: 'Norflox', generic: 'Norfloxacin', mfr: 'Cipla', hsn: HSN.ANTIBIOTIC, ppu: 4.4, rank: 190, strengths: ['400mg'] },
  { brand: 'Ciplox', generic: 'Ciprofloxacin', mfr: 'Cipla', hsn: HSN.ANTIBIOTIC, ppu: 5.2, rank: 280, strengths: ['500mg', '250mg'] },
  { brand: 'Cifran', generic: 'Ciprofloxacin', mfr: 'Sun Pharma', hsn: HSN.ANTIBIOTIC, ppu: 5.5, rank: 160, strengths: ['500mg', '250mg'] },
  { brand: 'Zanocin', generic: 'Ofloxacin', mfr: 'Sun Pharma', hsn: HSN.ANTIBIOTIC, ppu: 7.4, rank: 130, strengths: ['200mg', '400mg'] },
  { brand: 'Oflox', generic: 'Ofloxacin', mfr: 'Cipla', hsn: HSN.ANTIBIOTIC, ppu: 6.8, rank: 120, strengths: ['200mg', '400mg'] },
  { brand: 'O2', generic: 'Ofloxacin + Ornidazole', mfr: 'FDC', hsn: HSN.ANTIBIOTIC, ppu: 9.6, rank: 460, strengths: [variant('200mg+500mg', 'Ofloxacin 200mg + Ornidazole 500mg')] },
  { brand: 'Levoflox', generic: 'Levofloxacin', mfr: 'Cipla', sched: 'H1', hsn: HSN.ANTIBIOTIC, ppu: 13.5, rank: 240, strengths: ['500mg', '750mg', '250mg'] },
  { brand: 'L-Cin', generic: 'Levofloxacin', mfr: 'Lupin', sched: 'H1', hsn: HSN.ANTIBIOTIC, ppu: 12.4, rank: 150, strengths: ['500mg', '750mg'] },
  { brand: 'Linospan', generic: 'Linezolid', mfr: 'Cipla', sched: 'H1', hsn: HSN.ANTIBIOTIC, ppu: 78, rank: 30, strengths: ['600mg'] },
  { brand: 'Doxt-SL', generic: 'Doxycycline + Lactic Acid Bacillus', mfr: 'USV', hsn: HSN.ANTIBIOTIC, form: 'Capsule', ppu: 9.5, rank: 260, strengths: [variant('100mg+5billion', 'Doxycycline 100mg + Lactic Acid Bacillus 5 billion spores')] },
  { brand: 'Doxy-1', generic: 'Doxycycline', mfr: 'USV', hsn: HSN.ANTIBIOTIC, form: 'Capsule', ppu: 6.8, rank: 140, strengths: ['100mg'] },
  { brand: 'Roxid', generic: 'Roxithromycin', mfr: 'Alembic', hsn: HSN.ANTIBIOTIC, ppu: 12, rank: 130, strengths: ['150mg', '300mg'] },
  { brand: 'Septran', generic: 'Cotrimoxazole', mfr: 'GSK', hsn: HSN.ANTIBIOTIC, ppu: 3.2, rank: 90, strengths: [variant('800mg+160mg', 'Sulphamethoxazole 800mg + Trimethoprim 160mg')] },
  { brand: 'Dalacin C', generic: 'Clindamycin', mfr: 'Pfizer', hsn: HSN.ANTIBIOTIC, form: 'Capsule', ppu: 26, rank: 40, strengths: ['300mg'] },
  { brand: 'R-Cin', generic: 'Rifampicin', mfr: 'Lupin', sched: 'H1', hsn: HSN.ANTIBIOTIC, form: 'Capsule', ppu: 9.8, rank: 55, strengths: ['450mg', '600mg', '300mg'] },
  { brand: 'AKT-4', generic: 'Rifampicin + Isoniazid + Pyrazinamide + Ethambutol', mfr: 'Lupin', sched: 'H1', hsn: HSN.ANTIBIOTIC, ppu: 22, rank: 40, strengths: [variant('450mg+300mg+750mg+800mg', 'Rifampicin 450mg + Isoniazid 300mg + Pyrazinamide 750mg + Ethambutol 800mg')] },
  { brand: 'Forecox', generic: 'Rifampicin + Isoniazid + Pyrazinamide + Ethambutol', mfr: 'Macleods', sched: 'H1', hsn: HSN.ANTIBIOTIC, ppu: 20, rank: 30, strengths: [variant('450mg+300mg+750mg+800mg', 'Rifampicin 450mg + Isoniazid 300mg + Pyrazinamide 750mg + Ethambutol 800mg')] },
  { brand: 'Combutol', generic: 'Ethambutol', mfr: 'Lupin', sched: 'H1', hsn: HSN.ANTIBIOTIC, ppu: 5.6, rank: 25, strengths: ['800mg', '600mg'] },
  { brand: 'Myrin-P Forte', generic: 'Rifampicin + Isoniazid + Pyrazinamide + Ethambutol', mfr: 'Wockhardt', sched: 'H1', hsn: HSN.ANTIBIOTIC, ppu: 24, rank: 18, strengths: [variant('150mg+75mg+400mg+275mg', 'Rifampicin 150mg + Isoniazid 75mg + Pyrazinamide 400mg + Ethambutol 275mg')] },

  // --- acid suppression and GI ---
  { brand: 'Pan', generic: 'Pantoprazole', mfr: 'Alkem', ppu: 9.5, rank: 1250, strengths: ['40mg', '20mg'] },
  { brand: 'Pan-D', generic: 'Pantoprazole + Domperidone', mfr: 'Alkem', form: 'Capsule', ppu: 14.5, rank: 2100, strengths: [variant('40mg+30mg', 'Pantoprazole 40mg + Domperidone SR 30mg')] },
  { brand: 'Pantocid', generic: 'Pantoprazole', mfr: 'Sun Pharma', ppu: 10.2, rank: 720, strengths: ['40mg', '20mg'] },
  { brand: 'Pantocid DSR', generic: 'Pantoprazole + Domperidone', mfr: 'Sun Pharma', form: 'Capsule', ppu: 16, rank: 980, strengths: [variant('40mg+30mg', 'Pantoprazole 40mg + Domperidone SR 30mg')] },
  { brand: 'Omez', generic: 'Omeprazole', mfr: "Dr Reddy's", form: 'Capsule', ppu: 6.8, rank: 560, strengths: ['20mg', '40mg'] },
  { brand: 'Omez-D', generic: 'Omeprazole + Domperidone', mfr: "Dr Reddy's", form: 'Capsule', ppu: 9.4, rank: 300, strengths: [variant('20mg+10mg', 'Omeprazole 20mg + Domperidone 10mg')] },
  { brand: 'Nexpro', generic: 'Esomeprazole', mfr: 'Torrent', ppu: 12, rank: 480, strengths: ['40mg', '20mg'] },
  { brand: 'Nexpro RD', generic: 'Esomeprazole + Domperidone', mfr: 'Torrent', form: 'Capsule', ppu: 17.5, rank: 520, strengths: [variant('40mg+30mg', 'Esomeprazole 40mg + Domperidone SR 30mg')] },
  { brand: 'Razo', generic: 'Rabeprazole', mfr: "Dr Reddy's", ppu: 11, rank: 340, strengths: ['20mg', '10mg'] },
  { brand: 'Razo-D', generic: 'Rabeprazole + Domperidone', mfr: "Dr Reddy's", form: 'Capsule', ppu: 15.5, rank: 300, strengths: [variant('20mg+30mg', 'Rabeprazole 20mg + Domperidone SR 30mg')] },
  { brand: 'Rabium', generic: 'Rabeprazole + Domperidone', mfr: 'Intas', form: 'Capsule', ppu: 14, rank: 180, strengths: [variant('20mg+30mg', 'Rabeprazole 20mg + Domperidone SR 30mg')] },
  { brand: 'Sompraz', generic: 'Esomeprazole', mfr: 'Sun Pharma', ppu: 13, rank: 220, strengths: ['40mg', '20mg'] },
  { brand: 'Rantac', generic: 'Ranitidine', mfr: 'JB Chemicals', ppu: 2.3, rank: 260, strengths: ['150mg', '300mg'] },
  { brand: 'Aciloc', generic: 'Ranitidine', mfr: 'Cadila', ppu: 2.1, rank: 140, strengths: ['150mg', '300mg'] },
  { brand: 'Digene', generic: 'Magaldrate + Simethicone', mfr: 'Abbott', sched: 'OTC', form: 'Syrup', packs: [pack('200ml', 1), pack('450ml', 1, 2.1)], ppu: 145, rank: 640, strengths: [variant('400mg+20mg/5ml', 'Magaldrate 400mg + Simethicone 20mg per 5ml')] },
  { brand: 'Digene Chewable', generic: 'Magaldrate + Simethicone', mfr: 'Abbott', sched: 'OTC', packs: [pack('1x15', 15), pack('1x10', 10)], ppu: 2.6, rank: 320, strengths: [variant('400mg+20mg', 'Magaldrate 400mg + Simethicone 20mg')] },
  { brand: 'Gelusil MPS', generic: 'Aluminium Hydroxide + Magnesium Hydroxide + Simethicone', mfr: 'Pfizer', sched: 'OTC', form: 'Syrup', packs: [pack('200ml', 1), pack('450ml', 1, 2.1)], ppu: 125, rank: 300, strengths: [variant('250mg+250mg+50mg/5ml', 'Aluminium Hydroxide 250mg + Magnesium Hydroxide 250mg + Simethicone 50mg per 5ml')] },
  { brand: 'Cremaffin', generic: 'Liquid Paraffin + Milk of Magnesia', mfr: 'Abbott', sched: 'OTC', form: 'Syrup', packs: [pack('225ml', 1), pack('450ml', 1, 1.9)], ppu: 165, rank: 280, strengths: [variant('1.25ml+3.75ml/5ml', 'Liquid Paraffin 1.25ml + Milk of Magnesia 3.75ml per 5ml')] },
  { brand: 'Cremaffin Plus', generic: 'Sodium Picosulphate + Liquid Paraffin + Milk of Magnesia', mfr: 'Abbott', sched: 'OTC', form: 'Syrup', packs: [pack('225ml', 1), pack('450ml', 1, 1.9)], ppu: 185, rank: 220, strengths: [variant('3.33mg+1.25ml+3.75ml/5ml', 'Sodium Picosulphate 3.33mg + Liquid Paraffin 1.25ml + Milk of Magnesia 3.75ml per 5ml')] },
  { brand: 'Dulcolax', generic: 'Bisacodyl', mfr: 'Boehringer Ingelheim', sched: 'OTC', ppu: 4.2, rank: 190, strengths: ['5mg'] },
  { brand: 'Duphalac', generic: 'Lactulose', mfr: 'Abbott', sched: 'OTC', form: 'Syrup', packs: [pack('200ml', 1), pack('450ml', 1, 2.0)], ppu: 195, rank: 240, strengths: ['10g/15ml'] },
  { brand: 'Liv 52', generic: 'Ayurvedic Hepatoprotective', mfr: 'Himalaya', sched: 'OTC', hsn: HSN.AYURVEDIC, ppu: 1.4, rank: 320, strengths: [variant('Tablet', 'Himsra 36mg + Kasani 36mg + Mandur Bhasma 33mg')] },
  { brand: 'Liv 52 DS', generic: 'Ayurvedic Hepatoprotective', mfr: 'Himalaya', sched: 'OTC', hsn: HSN.AYURVEDIC, ppu: 2.6, rank: 210, strengths: [variant('Tablet', 'Himsra 72mg + Kasani 72mg + Mandur Bhasma 66mg')] },
  { brand: 'Cystone', generic: 'Ayurvedic Antilithiatic', mfr: 'Himalaya', sched: 'OTC', hsn: HSN.AYURVEDIC, ppu: 2.2, rank: 130, strengths: [variant('Tablet', 'Shilapushpa 65mg + Pashanabheda 49mg + Manjishtha 16mg')] },
  { brand: 'Ondem', generic: 'Ondansetron', mfr: 'Alkem', ppu: 5.8, rank: 340, strengths: ['4mg', '8mg'] },
  { brand: 'Emeset', generic: 'Ondansetron', mfr: 'Cipla', ppu: 5.2, rank: 210, strengths: ['4mg', '8mg'] },
  { brand: 'Vomikind', generic: 'Ondansetron', mfr: 'Mankind', ppu: 4.9, rank: 160, strengths: ['4mg', '8mg'] },
  { brand: 'Zofer', generic: 'Ondansetron', mfr: 'Sun Pharma', ppu: 5.4, rank: 120, strengths: ['4mg', '8mg'] },
  { brand: 'Perinorm', generic: 'Metoclopramide', mfr: 'Ipca', ppu: 2.2, rank: 150, strengths: ['10mg'] },
  { brand: 'Domstal', generic: 'Domperidone', mfr: 'Torrent', ppu: 3.1, rank: 280, strengths: ['10mg'] },
  { brand: 'Sporlac DS', generic: 'Lactic Acid Bacillus', mfr: 'Sanzyme', sched: 'OTC', ppu: 8.4, rank: 220, strengths: [variant('120 million spores', 'Lactic Acid Bacillus 120 million spores')] },
  { brand: 'Econorm', generic: 'Saccharomyces Boulardii', mfr: "Dr Reddy's", sched: 'OTC', form: 'Sachet', ppu: 38, rank: 260, strengths: ['250mg'] },
  { brand: 'Vizylac', generic: 'Lactic Acid Bacillus', mfr: 'Torrent', sched: 'OTC', form: 'Capsule', ppu: 6.2, rank: 110, strengths: [variant('60 million spores', 'Lactic Acid Bacillus 60 million spores')] },
  { brand: 'Unienzyme', generic: 'Fungal Diastase + Papain + Activated Charcoal', mfr: 'Torrent', sched: 'OTC', ppu: 4.6, rank: 190, strengths: [variant('50mg+50mg+75mg', 'Fungal Diastase 50mg + Papain 50mg + Activated Charcoal 75mg')] },
  { brand: 'Aristozyme', generic: 'Fungal Diastase + Pepsin', mfr: 'Aristo', sched: 'OTC', form: 'Syrup', ppu: 105, rank: 130, strengths: [variant('50mg+10mg/5ml', 'Fungal Diastase 50mg + Pepsin 10mg per 5ml')] },
  { brand: 'Normaxin', generic: 'Chlordiazepoxide + Clidinium + Dicyclomine', mfr: 'Systopic', ppu: 5.4, rank: 170, strengths: [variant('5mg+2.5mg+10mg', 'Chlordiazepoxide 5mg + Clidinium Bromide 2.5mg + Dicyclomine 10mg')] },
  { brand: 'Colospa', generic: 'Mebeverine', mfr: 'Abbott', ppu: 12, rank: 90, strengths: ['135mg'] },
  { brand: 'Rifagut', generic: 'Rifaximin', mfr: 'Sun Pharma', hsn: HSN.ANTIBIOTIC, ppu: 32, rank: 60, strengths: ['400mg', '550mg', '200mg'] },
  { brand: 'Udiliv', generic: 'Ursodeoxycholic Acid', mfr: 'Abbott', ppu: 22, rank: 130, strengths: ['300mg', '150mg'] },
  { brand: 'Hepamerz', generic: 'L-Ornithine L-Aspartate', mfr: 'Zydus', form: 'Sachet', ppu: 48, rank: 45, strengths: ['3g'] },

  // --- cardiovascular ---
  { brand: 'Telma', generic: 'Telmisartan', mfr: 'Glenmark', ppu: 7.2, rank: 1150, strengths: ['40mg', '20mg', '80mg'] },
  { brand: 'Telma H', generic: 'Telmisartan + Hydrochlorothiazide', mfr: 'Glenmark', ppu: 9.4, rank: 620, strengths: [variant('40mg+12.5mg', 'Telmisartan 40mg + Hydrochlorothiazide 12.5mg', '40'), variant('80mg+12.5mg', 'Telmisartan 80mg + Hydrochlorothiazide 12.5mg', '80')] },
  { brand: 'Telma AM', generic: 'Telmisartan + Amlodipine', mfr: 'Glenmark', ppu: 11, rank: 400, strengths: [variant('40mg+5mg', 'Telmisartan 40mg + Amlodipine 5mg', '40')] },
  { brand: 'Telmikind', generic: 'Telmisartan', mfr: 'Mankind', ppu: 5.8, rank: 280, strengths: ['40mg', '20mg', '80mg'] },
  { brand: 'Telsartan', generic: 'Telmisartan', mfr: "Dr Reddy's", ppu: 6.4, rank: 190, strengths: ['40mg', '80mg'] },
  { brand: 'Amlong', generic: 'Amlodipine', mfr: 'Micro Labs', ppu: 3.1, rank: 780, strengths: ['5mg', '2.5mg', '10mg'] },
  { brand: 'Amlokind', generic: 'Amlodipine', mfr: 'Mankind', ppu: 2.4, rank: 320, strengths: ['5mg', '2.5mg', '10mg'] },
  { brand: 'Stamlo', generic: 'Amlodipine', mfr: "Dr Reddy's", ppu: 3.4, rank: 260, strengths: ['5mg', '2.5mg'] },
  { brand: 'Losar', generic: 'Losartan Potassium', mfr: 'Unichem', ppu: 4.4, rank: 340, strengths: ['50mg', '25mg'] },
  { brand: 'Losar H', generic: 'Losartan Potassium + Hydrochlorothiazide', mfr: 'Unichem', ppu: 6.2, rank: 180, strengths: [variant('50mg+12.5mg', 'Losartan Potassium 50mg + Hydrochlorothiazide 12.5mg', '50')] },
  { brand: 'Repace', generic: 'Losartan Potassium', mfr: 'Sun Pharma', ppu: 4.1, rank: 120, strengths: ['50mg', '25mg'] },
  { brand: 'Concor', generic: 'Bisoprolol', mfr: 'Merck', ppu: 9.6, rank: 380, strengths: ['5mg', '2.5mg', '10mg'] },
  { brand: 'Concor AM', generic: 'Bisoprolol + Amlodipine', mfr: 'Merck', ppu: 13, rank: 150, strengths: [variant('5mg+5mg', 'Bisoprolol 5mg + Amlodipine 5mg', '5')] },
  { brand: 'Metolar', generic: 'Metoprolol Tartrate', mfr: 'Cipla', ppu: 3.4, rank: 260, strengths: ['50mg', '25mg'] },
  { brand: 'Metolar XR', generic: 'Metoprolol Succinate', mfr: 'Cipla', ppu: 6.8, rank: 200, strengths: ['50mg', '25mg', '100mg'] },
  { brand: 'Met XL', generic: 'Metoprolol Succinate', mfr: 'Ajanta', ppu: 7.2, rank: 420, strengths: ['50mg', '25mg', '12.5mg'] },
  { brand: 'Prolomet XL', generic: 'Metoprolol Succinate', mfr: 'Sun Pharma', ppu: 7.4, rank: 240, strengths: ['50mg', '25mg'] },
  { brand: 'Revelol', generic: 'Metoprolol Succinate', mfr: 'Ipca', ppu: 5.2, rank: 130, strengths: ['50mg', '25mg'] },
  { brand: 'Ecosprin', generic: 'Aspirin', mfr: 'USV', ppu: 0.85, rank: 1900, strengths: ['75mg', '150mg', '325mg'] },
  { brand: 'Ecosprin AV', generic: 'Aspirin + Atorvastatin', mfr: 'USV', form: 'Capsule', ppu: 6.4, rank: 480, strengths: [variant('75mg+20mg', 'Aspirin 75mg + Atorvastatin 20mg', '75'), variant('150mg+20mg', 'Aspirin 150mg + Atorvastatin 20mg', '150')] },
  { brand: 'Clopilet', generic: 'Clopidogrel', mfr: 'Sun Pharma', ppu: 8.2, rank: 320, strengths: ['75mg', '150mg'] },
  { brand: 'Clopilet A', generic: 'Clopidogrel + Aspirin', mfr: 'Sun Pharma', form: 'Capsule', ppu: 10.5, rank: 260, strengths: [variant('75mg+75mg', 'Clopidogrel 75mg + Aspirin 75mg', '75')] },
  { brand: 'Ceruvin', generic: 'Clopidogrel', mfr: 'Sun Pharma', ppu: 8.6, rank: 190, strengths: ['75mg', '150mg'] },
  { brand: 'Deplatt', generic: 'Clopidogrel', mfr: 'Torrent', ppu: 8.1, rank: 160, strengths: ['75mg', '150mg'] },
  { brand: 'Atorva', generic: 'Atorvastatin', mfr: 'Zydus', ppu: 5.2, rank: 620, strengths: ['10mg', '20mg', '40mg'] },
  { brand: 'Storvas', generic: 'Atorvastatin', mfr: 'Sun Pharma', ppu: 5.6, rank: 380, strengths: ['10mg', '20mg', '40mg'] },
  { brand: 'Lipvas', generic: 'Atorvastatin', mfr: 'Cipla', ppu: 4.8, rank: 140, strengths: ['10mg', '20mg'] },
  { brand: 'Rosuvas', generic: 'Rosuvastatin', mfr: 'Sun Pharma', ppu: 11, rank: 520, strengths: ['10mg', '5mg', '20mg'] },
  { brand: 'Rosulip', generic: 'Rosuvastatin', mfr: 'Cipla', ppu: 10, rank: 190, strengths: ['10mg', '20mg'] },
  { brand: 'Nikoran', generic: 'Nicorandil', mfr: 'USV', ppu: 9.2, rank: 90, strengths: ['5mg', '10mg'] },
  { brand: 'Sorbitrate', generic: 'Isosorbide Dinitrate', mfr: 'Abbott', ppu: 1.6, rank: 110, strengths: ['5mg', '10mg'] },
  { brand: 'Cardivas', generic: 'Carvedilol', mfr: 'Sun Pharma', ppu: 6.4, rank: 100, strengths: ['3.125mg', '6.25mg', '12.5mg'] },
  { brand: 'Envas', generic: 'Enalapril Maleate', mfr: 'Cadila', ppu: 3.2, rank: 90, strengths: ['5mg', '2.5mg', '10mg'] },
  { brand: 'Lisoril', generic: 'Lisinopril', mfr: 'Ipca', ppu: 3.8, rank: 70, strengths: ['5mg', '10mg'] },
  { brand: 'Dytor', generic: 'Torsemide', mfr: 'Cipla', ppu: 5.4, rank: 130, strengths: ['10mg', '20mg', '5mg'] },
  { brand: 'Dytor Plus', generic: 'Torsemide + Spironolactone', mfr: 'Cipla', ppu: 9.6, rank: 90, strengths: [variant('10mg+50mg', 'Torsemide 10mg + Spironolactone 50mg', '10')] },
  { brand: 'Lasix', generic: 'Furosemide', mfr: 'Sanofi', ppu: 1.4, rank: 160, strengths: ['40mg'] },
  { brand: 'Aldactone', generic: 'Spironolactone', mfr: 'RPG Life Sciences', ppu: 5.8, rank: 110, strengths: ['25mg', '50mg', '100mg'] },
  { brand: 'Nebicard', generic: 'Nebivolol', mfr: 'Torrent', ppu: 8.4, rank: 220, strengths: ['5mg', '2.5mg'] },
  { brand: 'Cilacar', generic: 'Cilnidipine', mfr: 'JB Chemicals', ppu: 10.5, rank: 280, strengths: ['10mg', '20mg', '5mg'] },
  { brand: 'Cilacar T', generic: 'Cilnidipine + Telmisartan', mfr: 'JB Chemicals', ppu: 14, rank: 190, strengths: [variant('10mg+40mg', 'Cilnidipine 10mg + Telmisartan 40mg', '10')] },
  { brand: 'Olmesar', generic: 'Olmesartan Medoxomil', mfr: 'Macleods', ppu: 8.8, rank: 170, strengths: ['20mg', '40mg'] },
  { brand: 'Olmezest', generic: 'Olmesartan Medoxomil', mfr: 'Intas', ppu: 9.2, rank: 150, strengths: ['20mg', '40mg'] },

  // --- diabetes ---
  { brand: 'Glycomet', generic: 'Metformin', mfr: 'USV', ppu: 1.5, rank: 980, strengths: ['500mg', '850mg', '1000mg'] },
  { brand: 'Glycomet GP', generic: 'Glimepiride + Metformin', mfr: 'USV', ppu: 6.4, rank: 860, strengths: [variant('1mg+500mg', 'Glimepiride 1mg + Metformin 500mg', '1'), variant('2mg+500mg', 'Glimepiride 2mg + Metformin 500mg', '2'), variant('0.5mg+500mg', 'Glimepiride 0.5mg + Metformin 500mg', '0.5')] },
  { brand: 'Glimisave', generic: 'Glimepiride', mfr: 'USV', ppu: 4.8, rank: 380, strengths: ['2mg', '1mg', '3mg'] },
  { brand: 'Glimisave M', generic: 'Glimepiride + Metformin', mfr: 'USV', ppu: 6.1, rank: 300, strengths: [variant('1mg+500mg', 'Glimepiride 1mg + Metformin 500mg', '1'), variant('2mg+500mg', 'Glimepiride 2mg + Metformin 500mg', '2')] },
  { brand: 'Amaryl', generic: 'Glimepiride', mfr: 'Sanofi', ppu: 8.4, rank: 420, strengths: ['2mg', '1mg', '3mg'] },
  { brand: 'Amaryl M', generic: 'Glimepiride + Metformin', mfr: 'Sanofi', ppu: 11, rank: 340, strengths: [variant('1mg+500mg', 'Glimepiride 1mg + Metformin 500mg', '1'), variant('2mg+500mg', 'Glimepiride 2mg + Metformin 500mg', '2')] },
  { brand: 'Januvia', generic: 'Sitagliptin', mfr: 'MSD Pharmaceuticals', ppu: 26, rank: 300, strengths: ['100mg', '50mg'] },
  { brand: 'Istamet', generic: 'Sitagliptin + Metformin', mfr: 'MSD Pharmaceuticals', ppu: 24, rank: 340, strengths: [variant('50mg+500mg', 'Sitagliptin 50mg + Metformin 500mg', '50/500'), variant('50mg+1000mg', 'Sitagliptin 50mg + Metformin 1000mg', '50/1000')] },
  { brand: 'Galvus', generic: 'Vildagliptin', mfr: 'Novartis', ppu: 22, rank: 260, strengths: ['50mg'] },
  { brand: 'Galvus Met', generic: 'Vildagliptin + Metformin', mfr: 'Novartis', ppu: 24, rank: 280, strengths: [variant('50mg+500mg', 'Vildagliptin 50mg + Metformin 500mg', '50/500'), variant('50mg+1000mg', 'Vildagliptin 50mg + Metformin 1000mg', '50/1000')] },
  { brand: 'Zomelis', generic: 'Vildagliptin', mfr: 'USV', ppu: 18, rank: 150, strengths: ['50mg'] },
  { brand: 'Jardiance', generic: 'Empagliflozin', mfr: 'Boehringer Ingelheim', ppu: 32, rank: 190, strengths: ['10mg', '25mg'] },
  { brand: 'Forxiga', generic: 'Dapagliflozin', mfr: 'AstraZeneca', ppu: 30, rank: 210, strengths: ['10mg'] },
  { brand: 'Reclide', generic: 'Gliclazide', mfr: 'Serdia', ppu: 5.6, rank: 90, strengths: ['80mg', '30mg'] },
  { brand: 'Pioz', generic: 'Pioglitazone', mfr: 'USV', ppu: 6.2, rank: 70, strengths: ['15mg', '30mg'] },
  { brand: 'Human Mixtard', generic: 'Insulin Human', mfr: 'Novo Nordisk', form: 'Injection', hsn: HSN.INSULIN, cold: true, packs: [pack('10ml vial', 1), pack('3ml penfill x5', 1, 2.3)], ppu: 175, rank: 160, strengths: [variant('100IU/ml', 'Insulin Human (30/70) 100IU/ml')] },
  { brand: 'Actrapid', generic: 'Insulin Human', mfr: 'Novo Nordisk', form: 'Injection', hsn: HSN.INSULIN, cold: true, packs: [pack('10ml vial', 1)], ppu: 160, rank: 45, strengths: ['100IU/ml'] },
  { brand: 'NovoRapid', generic: 'Insulin Aspart', mfr: 'Novo Nordisk', form: 'Injection', hsn: HSN.INSULIN, cold: true, packs: [pack('3ml penfill', 1), pack('10ml vial', 1, 2.6)], ppu: 620, rank: 55, strengths: ['100IU/ml'] },
  { brand: 'Lantus', generic: 'Insulin Glargine', mfr: 'Sanofi', form: 'Injection', hsn: HSN.INSULIN, cold: true, packs: [pack('3ml cartridge', 1), pack('10ml vial', 1, 2.6)], ppu: 850, rank: 90, strengths: ['100IU/ml'] },
  { brand: 'Huminsulin', generic: 'Insulin Human', mfr: 'Eli Lilly', form: 'Injection', hsn: HSN.INSULIN, cold: true, packs: [pack('10ml vial', 1)], ppu: 165, rank: 60, strengths: [variant('100IU/ml', 'Insulin Human (30/70) 100IU/ml')] },
  { brand: 'Basalog', generic: 'Insulin Glargine', mfr: 'Biocon', form: 'Injection', hsn: HSN.INSULIN, cold: true, packs: [pack('3ml cartridge', 1), pack('10ml vial', 1, 2.5)], ppu: 480, rank: 50, strengths: ['100IU/ml'] },

  // --- thyroid, steroids, hormones ---
  { brand: 'Thyronorm', generic: 'Thyroxine Sodium', mfr: 'Abbott', step: '0.5', packs: THYROID_PACKS, ppu: 1.35, rank: 1250, strengths: ['50mcg', '25mcg', '75mcg', '100mcg', '12.5mcg', '62.5mcg', '88mcg'] },
  { brand: 'Eltroxin', generic: 'Thyroxine Sodium', mfr: 'GSK', step: '0.5', packs: THYROID_PACKS, ppu: 1.25, rank: 320, strengths: ['50mcg', '25mcg', '100mcg'] },
  { brand: 'Thyrox', generic: 'Thyroxine Sodium', mfr: 'Macleods', step: '0.5', packs: THYROID_PACKS, ppu: 1.15, rank: 210, strengths: ['50mcg', '100mcg'] },
  { brand: 'Neomercazole', generic: 'Carbimazole', mfr: 'Abbott', ppu: 4.2, rank: 60, strengths: ['5mg', '10mg'] },
  { brand: 'Wysolone', generic: 'Prednisolone', mfr: 'Wyeth', hsn: HSN.CORTICOSTEROID, step: '0.5', ppu: 2.4, rank: 380, strengths: ['10mg', '5mg', '20mg', '40mg'] },
  { brand: 'Omnacortil', generic: 'Prednisolone', mfr: 'Macleods', hsn: HSN.CORTICOSTEROID, step: '0.5', ppu: 2.2, rank: 320, strengths: ['10mg', '5mg', '20mg', '40mg'] },
  { brand: 'Medrol', generic: 'Methylprednisolone', mfr: 'Pfizer', hsn: HSN.CORTICOSTEROID, step: '0.5', ppu: 12, rank: 220, strengths: ['16mg', '8mg', '4mg'] },
  { brand: 'Defcort', generic: 'Deflazacort', mfr: 'Macleods', hsn: HSN.CORTICOSTEROID, ppu: 14, rank: 180, strengths: ['6mg', '30mg', '12mg'] },
  { brand: 'Duphaston', generic: 'Dydrogesterone', mfr: 'Abbott', ppu: 42, rank: 180, strengths: ['10mg'] },
  { brand: 'Susten', generic: 'Natural Micronised Progesterone', mfr: 'Sun Pharma', form: 'Capsule', ppu: 26, rank: 130, strengths: ['200mg', '100mg', '400mg'] },
  { brand: 'Regestrone', generic: 'Norethisterone', mfr: 'Torrent', ppu: 8.4, rank: 90, strengths: ['5mg', '10mg'] },
  { brand: 'Meprate', generic: 'Medroxyprogesterone', mfr: 'Serum Institute', ppu: 9.2, rank: 80, strengths: ['10mg'] },
  { brand: 'i-pill', generic: 'Levonorgestrel', mfr: 'Piramal', packs: SINGLE_TAB, ppu: 110, rank: 240, strengths: ['1.5mg'] },
  { brand: 'Unwanted 72', generic: 'Levonorgestrel', mfr: 'Mankind', packs: SINGLE_TAB, ppu: 85, rank: 190, strengths: ['1.5mg'] },

  // --- respiratory and anti-allergy ---
  { brand: 'Montek LC', generic: 'Montelukast + Levocetirizine', mfr: 'Sun Pharma', ppu: 12.5, rank: 1600, strengths: [variant('10mg+5mg', 'Montelukast 10mg + Levocetirizine 5mg')] },
  { brand: 'Montek', generic: 'Montelukast', mfr: 'Sun Pharma', ppu: 9.8, rank: 420, strengths: ['10mg', '4mg', '5mg'] },
  { brand: 'Montair LC', generic: 'Montelukast + Levocetirizine', mfr: 'Cipla', ppu: 11.8, rank: 720, strengths: [variant('10mg+5mg', 'Montelukast 10mg + Levocetirizine 5mg')] },
  { brand: 'Montair', generic: 'Montelukast', mfr: 'Cipla', ppu: 9.4, rank: 340, strengths: ['10mg', '5mg', '4mg'] },
  { brand: 'Allegra', generic: 'Fexofenadine', mfr: 'Sanofi', ppu: 12, rank: 680, strengths: ['120mg', '180mg', '30mg'] },
  { brand: 'Allegra-M', generic: 'Fexofenadine + Montelukast', mfr: 'Sanofi', ppu: 16, rank: 280, strengths: [variant('120mg+10mg', 'Fexofenadine 120mg + Montelukast 10mg', '120')] },
  { brand: 'Cetzine', generic: 'Cetirizine', mfr: "Dr Reddy's", ppu: 2.4, rank: 460, strengths: ['10mg', '5mg'] },
  { brand: 'Alerid', generic: 'Cetirizine', mfr: 'Cipla', ppu: 2.1, rank: 240, strengths: ['10mg', '5mg'] },
  { brand: 'Okacet', generic: 'Cetirizine', mfr: 'Cipla', ppu: 2.0, rank: 160, strengths: ['10mg'] },
  { brand: 'Avil', generic: 'Pheniramine Maleate', mfr: 'Sanofi', ppu: 1.6, rank: 180, strengths: ['25mg', '50mg'] },
  { brand: 'Teczine', generic: 'Levocetirizine', mfr: 'Ajanta', ppu: 4.2, rank: 260, strengths: ['5mg', '10mg'] },
  { brand: 'Xyzal', generic: 'Levocetirizine', mfr: 'UCB', ppu: 6.4, rank: 190, strengths: ['5mg'] },
  { brand: 'Ascoril LS', generic: 'Ambroxol + Levosalbutamol + Guaiphenesin', mfr: 'Glenmark', form: 'Syrup', ppu: 128, rank: 780, strengths: [variant('30mg+1mg+50mg/5ml', 'Ambroxol 30mg + Levosalbutamol 1mg + Guaiphenesin 50mg per 5ml')] },
  { brand: 'Ascoril Plus', generic: 'Bromhexine + Terbutaline + Guaiphenesin', mfr: 'Glenmark', form: 'Syrup', ppu: 118, rank: 420, strengths: [variant('4mg+1.25mg+50mg/5ml', 'Bromhexine 4mg + Terbutaline 1.25mg + Guaiphenesin 50mg per 5ml')] },
  { brand: 'Ascoril D Plus', generic: 'Dextromethorphan + Phenylephrine + Chlorpheniramine', mfr: 'Glenmark', form: 'Syrup', ppu: 122, rank: 340, strengths: [variant('10mg+5mg+2mg/5ml', 'Dextromethorphan 10mg + Phenylephrine 5mg + Chlorpheniramine 2mg per 5ml')] },
  { brand: 'Grilinctus', generic: 'Chlorpheniramine + Dextromethorphan + Guaiphenesin', mfr: 'Franco-Indian', form: 'Syrup', ppu: 112, rank: 260, strengths: [variant('2.5mg+5mg+50mg/5ml', 'Chlorpheniramine 2.5mg + Dextromethorphan 5mg + Guaiphenesin 50mg per 5ml')] },
  { brand: 'Zeet Expectorant', generic: 'Terbutaline + Bromhexine + Guaiphenesin', mfr: 'Wallace Pharmaceuticals', form: 'Syrup', ppu: 108, rank: 190, strengths: [variant('1.25mg+2mg+50mg/5ml', 'Terbutaline 1.25mg + Bromhexine 2mg + Guaiphenesin 50mg per 5ml')] },
  { brand: 'Levolin', generic: 'Levosalbutamol', mfr: 'Cipla', ppu: 4.8, rank: 220, strengths: ['1mg', '2mg'] },
  { brand: 'Levolin Inhaler', generic: 'Levosalbutamol', mfr: 'Cipla', form: 'Inhaler', packs: [pack('200 MD', 1)], ppu: 175, rank: 180, strengths: ['50mcg'] },
  { brand: 'Levolin Respules', generic: 'Levosalbutamol', mfr: 'Cipla', form: 'Other', packs: [pack('5x2.5ml', 5)], ppu: 18, rank: 210, strengths: ['1.25mg/2.5ml'] },
  { brand: 'Duolin Respules', generic: 'Levosalbutamol + Ipratropium', mfr: 'Cipla', form: 'Other', packs: [pack('5x2.5ml', 5)], ppu: 22, rank: 190, strengths: [variant('1.25mg+500mcg', 'Levosalbutamol 1.25mg + Ipratropium Bromide 500mcg per 2.5ml')] },
  { brand: 'Duolin Inhaler', generic: 'Levosalbutamol + Ipratropium', mfr: 'Cipla', form: 'Inhaler', packs: [pack('200 MD', 1)], ppu: 285, rank: 160, strengths: [variant('50mcg+20mcg', 'Levosalbutamol 50mcg + Ipratropium Bromide 20mcg per dose')] },
  { brand: 'Foracort', generic: 'Formoterol + Budesonide', mfr: 'Cipla', form: 'Inhaler', ppu: 385, rank: 260, strengths: [variant('6mcg+200mcg', 'Formoterol 6mcg + Budesonide 200mcg per dose', '200'), variant('6mcg+400mcg', 'Formoterol 6mcg + Budesonide 400mcg per dose', '400'), variant('6mcg+100mcg', 'Formoterol 6mcg + Budesonide 100mcg per dose', '100')] },
  { brand: 'Foracort Rotacaps', generic: 'Formoterol + Budesonide', mfr: 'Cipla', form: 'Capsule', packs: [pack('1x30', 30)], ppu: 12, rank: 140, strengths: [variant('6mcg+200mcg', 'Formoterol 6mcg + Budesonide 200mcg', '200'), variant('6mcg+400mcg', 'Formoterol 6mcg + Budesonide 400mcg', '400')] },
  { brand: 'Seroflo', generic: 'Salmeterol + Fluticasone', mfr: 'Cipla', form: 'Inhaler', ppu: 445, rank: 190, strengths: [variant('25mcg+250mcg', 'Salmeterol 25mcg + Fluticasone Propionate 250mcg per dose', '250'), variant('25mcg+125mcg', 'Salmeterol 25mcg + Fluticasone Propionate 125mcg per dose', '125')] },
  { brand: 'Asthalin', generic: 'Salbutamol', mfr: 'Cipla', ppu: 1.3, rank: 200, strengths: ['2mg', '4mg'] },
  { brand: 'Asthalin Inhaler', generic: 'Salbutamol', mfr: 'Cipla', form: 'Inhaler', packs: [pack('200 MD', 1)], ppu: 145, rank: 280, strengths: ['100mcg'] },
  { brand: 'Budecort', generic: 'Budesonide', mfr: 'Cipla', form: 'Inhaler', ppu: 395, rank: 150, strengths: [variant('200mcg', 'Budesonide 200mcg per dose', '200'), variant('100mcg', 'Budesonide 100mcg per dose', '100')] },
  { brand: 'Deriphyllin', generic: 'Etophylline + Theophylline', mfr: 'Zydus', ppu: 3.2, rank: 130, strengths: [variant('77mg+23mg', 'Etophylline 77mg + Theophylline 23mg')] },
  { brand: 'Sinarest', generic: 'Paracetamol + Phenylephrine + Chlorpheniramine', mfr: 'Centaur', sched: 'OTC', ppu: 5.8, rank: 720, strengths: [variant('500mg+10mg+2mg', 'Paracetamol 500mg + Phenylephrine 10mg + Chlorpheniramine 2mg')] },
  { brand: 'Sinarest Syrup', generic: 'Paracetamol + Phenylephrine + Chlorpheniramine', mfr: 'Centaur', sched: 'OTC', form: 'Syrup', ppu: 98, rank: 240, strengths: [variant('125mg+5mg+1mg/5ml', 'Paracetamol 125mg + Phenylephrine 5mg + Chlorpheniramine 1mg per 5ml')] },
  { brand: 'Cheston Cold', generic: 'Cetirizine + Paracetamol + Phenylephrine', mfr: 'Cipla', sched: 'OTC', ppu: 5.4, rank: 380, strengths: [variant('5mg+325mg+10mg', 'Cetirizine 5mg + Paracetamol 325mg + Phenylephrine 10mg')] },
  { brand: 'Wikoryl', generic: 'Paracetamol + Phenylephrine + Chlorpheniramine + Caffeine', mfr: 'Alembic', sched: 'OTC', ppu: 4.9, rank: 240, strengths: [variant('500mg+10mg+2mg+30mg', 'Paracetamol 500mg + Phenylephrine 10mg + Chlorpheniramine 2mg + Caffeine 30mg')] },
  { brand: 'Otrivin', generic: 'Xylometazoline', mfr: 'GSK', sched: 'OTC', form: 'Drops', packs: [pack('10ml', 1)], ppu: 82, rank: 300, strengths: ['0.1% w/v', '0.05% w/v'] },
  { brand: 'Nasivion', generic: 'Oxymetazoline', mfr: 'Merck', sched: 'OTC', form: 'Drops', packs: [pack('10ml', 1)], ppu: 78, rank: 200, strengths: ['0.05% w/v', '0.025% w/v'] },
  { brand: 'Nasoclear', generic: 'Sodium Chloride', mfr: 'Cipla', sched: 'OTC', form: 'Drops', packs: [pack('15ml', 1)], ppu: 105, rank: 180, strengths: ['0.65% w/v'] },
  { brand: 'Nasonex', generic: 'Mometasone Furoate', mfr: 'MSD Pharmaceuticals', form: 'Drops', packs: [pack('18g spray', 1)], ppu: 520, rank: 70, strengths: ['50mcg/dose'] },

  // --- CNS and psychiatric ---
  { brand: 'Alprax', generic: 'Alprazolam', mfr: 'Torrent', sched: 'H1', ppu: 2.4, rank: 260, strengths: ['0.5mg', '0.25mg', '1mg'] },
  { brand: 'Restyl', generic: 'Alprazolam', mfr: 'Sun Pharma', sched: 'H1', ppu: 2.6, rank: 210, strengths: ['0.5mg', '0.25mg', '1mg'] },
  { brand: 'Clonotril', generic: 'Clonazepam', mfr: 'Torrent', sched: 'H1', ppu: 3.1, rank: 190, strengths: ['0.5mg', '0.25mg', '1mg', '2mg'] },
  { brand: 'Rivotril', generic: 'Clonazepam', mfr: 'Abbott', sched: 'H1', ppu: 3.4, rank: 120, strengths: ['0.5mg', '2mg'] },
  { brand: 'Zapiz', generic: 'Clonazepam', mfr: 'Sun Pharma', sched: 'H1', ppu: 2.9, rank: 100, strengths: ['0.25mg', '0.5mg'] },
  { brand: 'Etizola', generic: 'Etizolam', mfr: 'Sun Pharma', sched: 'H1', ppu: 3.6, rank: 170, strengths: ['0.5mg', '0.25mg', '1mg'] },
  { brand: 'Zolfresh', generic: 'Zolpidem', mfr: 'Abbott', sched: 'H1', ppu: 9.8, rank: 140, strengths: ['10mg', '5mg'] },
  { brand: 'Nitrosun', generic: 'Nitrazepam', mfr: 'Sun Pharma', sched: 'H1', ppu: 3.2, rank: 80, strengths: ['10mg', '5mg'] },
  { brand: 'Lyrica', generic: 'Pregabalin', mfr: 'Pfizer', sched: 'H1', form: 'Capsule', ppu: 28, rank: 130, strengths: ['75mg', '150mg', '50mg'] },
  { brand: 'Pregabid', generic: 'Pregabalin', mfr: 'Intas', sched: 'H1', form: 'Capsule', ppu: 14, rank: 210, strengths: ['75mg', '150mg', '50mg'] },
  { brand: 'Gabapin', generic: 'Gabapentin', mfr: 'Intas', form: 'Capsule', ppu: 9.6, rank: 180, strengths: ['300mg', '100mg', '400mg'] },
  { brand: 'Gabapin NT', generic: 'Gabapentin + Nortriptyline', mfr: 'Intas', ppu: 11, rank: 240, strengths: [variant('400mg+10mg', 'Gabapentin 400mg + Nortriptyline 10mg', '400'), variant('100mg+10mg', 'Gabapentin 100mg + Nortriptyline 10mg', '100')] },
  { brand: 'Nexito', generic: 'Escitalopram', mfr: 'Sun Pharma', step: '0.5', ppu: 6.8, rank: 320, strengths: ['10mg', '5mg', '20mg'] },
  { brand: 'Nexito Plus', generic: 'Escitalopram + Clonazepam', mfr: 'Sun Pharma', sched: 'H1', ppu: 9.4, rank: 190, strengths: [variant('5mg+0.5mg', 'Escitalopram 5mg + Clonazepam 0.5mg', '5')] },
  { brand: 'Rexipra', generic: 'Escitalopram', mfr: 'Intas', step: '0.5', ppu: 6.2, rank: 130, strengths: ['10mg', '5mg'] },
  { brand: 'Stalopam', generic: 'Escitalopram', mfr: 'Torrent', step: '0.5', ppu: 6.4, rank: 110, strengths: ['10mg', '5mg'] },
  { brand: 'Amitone', generic: 'Amitriptyline', mfr: 'Intas', step: '0.5', ppu: 2.6, rank: 140, strengths: ['10mg', '25mg', '75mg'] },
  { brand: 'Prothiaden', generic: 'Dothiepin', mfr: 'Abbott', ppu: 8.2, rank: 70, strengths: ['25mg', '75mg'] },
  { brand: 'Sertima', generic: 'Sertraline', mfr: 'Torrent', step: '0.5', ppu: 8.6, rank: 120, strengths: ['50mg', '25mg', '100mg'] },
  { brand: 'Daxid', generic: 'Sertraline', mfr: 'Pfizer', ppu: 9.4, rank: 80, strengths: ['50mg', '100mg'] },
  { brand: 'Qutipin', generic: 'Quetiapine', mfr: 'Sun Pharma', step: '0.5', ppu: 7.4, rank: 100, strengths: ['25mg', '50mg', '100mg'] },
  { brand: 'Oleanz', generic: 'Olanzapine', mfr: 'Sun Pharma', step: '0.5', ppu: 9.2, rank: 110, strengths: ['5mg', '2.5mg', '10mg'] },
  { brand: 'Sizodon', generic: 'Risperidone', mfr: 'Sun Pharma', step: '0.5', ppu: 6.8, rank: 90, strengths: ['2mg', '1mg', '3mg'] },
  { brand: 'Levipil', generic: 'Levetiracetam', mfr: 'Intas', ppu: 12, rank: 160, strengths: ['500mg', '250mg', '1000mg'] },
  { brand: 'Eptoin', generic: 'Phenytoin Sodium', mfr: 'Abbott', ppu: 2.4, rank: 90, strengths: ['100mg', '50mg'] },
  { brand: 'Encorate Chrono', generic: 'Sodium Valproate + Valproic Acid', mfr: 'Sun Pharma', ppu: 9.8, rank: 110, strengths: [variant('500mg', 'Sodium Valproate 333mg + Valproic Acid 145mg', '500'), variant('300mg', 'Sodium Valproate 200mg + Valproic Acid 87mg', '300')] },
  { brand: 'Betacap TR', generic: 'Propranolol', mfr: 'Sun Pharma', form: 'Capsule', ppu: 6.4, rank: 140, strengths: ['40mg', '20mg', '60mg'] },
  { brand: 'Vertin', generic: 'Betahistine', mfr: 'Abbott', ppu: 8.2, rank: 220, strengths: ['16mg', '8mg', '24mg'] },
  { brand: 'Stemetil', generic: 'Prochlorperazine', mfr: 'Abbott', ppu: 3.4, rank: 130, strengths: ['5mg'] },
  { brand: 'Stugeron', generic: 'Cinnarizine', mfr: 'Janssen', ppu: 3.8, rank: 90, strengths: ['25mg'] },

  // --- Schedule X. One SKU each: the register, not the shelf, is the point ---
  { brand: 'Gardenal', generic: 'Phenobarbitone', mfr: 'Nicholas Piramal', sched: 'X', packs: [pack('1x10', 10)], ppu: 1.8, rank: 25, strengths: ['30mg'] },
  { brand: 'Fortwin', generic: 'Pentazocine', mfr: 'Ranbaxy', sched: 'X', form: 'Injection', packs: [pack('1ml amp', 1)], ppu: 24, rank: 12, strengths: ['30mg/ml'] },
  { brand: 'Addwize', generic: 'Methylphenidate', mfr: 'Intas', sched: 'X', packs: [pack('1x10', 10)], ppu: 12, rank: 18, strengths: ['10mg'] },
  { brand: 'Inspiral SR', generic: 'Methylphenidate', mfr: 'Sun Pharma', sched: 'X', packs: [pack('1x10', 10)], ppu: 22, rank: 10, strengths: ['20mg'] },
  { brand: 'Ketmin', generic: 'Ketamine', mfr: 'Themis Medicare', sched: 'X', form: 'Injection', packs: [pack('10ml vial', 1)], ppu: 68, rank: 6, strengths: ['50mg/ml'] },

  // --- vitamins, minerals, nutraceuticals ---
  { brand: 'Shelcal 500', generic: 'Calcium Carbonate + Vitamin D3', mfr: 'Torrent', sched: 'OTC', hsn: HSN.VITAMIN, packs: [pack('1x15', 15), pack('1x10', 10)], ppu: 9.4, rank: 1700, strengths: [variant('500mg+250IU', 'Calcium Carbonate 1250mg (elemental Calcium 500mg) + Vitamin D3 250IU')] },
  { brand: 'Shelcal HD', generic: 'Calcium Carbonate + Vitamin D3', mfr: 'Torrent', sched: 'OTC', hsn: HSN.VITAMIN, packs: [pack('1x15', 15), pack('1x10', 10)], ppu: 12.5, rank: 480, strengths: [variant('500mg+2000IU', 'Calcium Carbonate 1250mg + Vitamin D3 2000IU')] },
  { brand: 'Shelcal XT', generic: 'Calcium Citrate Malate + Vitamin D3 + Zinc', mfr: 'Torrent', sched: 'OTC', hsn: HSN.VITAMIN, packs: [pack('1x15', 15)], ppu: 14, rank: 220, strengths: [variant('1000mg+1000IU', 'Calcium Citrate Malate 1000mg + Vitamin D3 1000IU + Zinc 4mg')] },
  { brand: 'Calcimax', generic: 'Calcium Citrate + Vitamin D3 + Zinc', mfr: 'Meyer Organics', sched: 'OTC', hsn: HSN.VITAMIN, ppu: 8.4, rank: 260, strengths: [variant('1000mg+200IU', 'Calcium Citrate 1000mg + Vitamin D3 200IU + Zinc 7.5mg')] },
  { brand: 'Ostocalcium', generic: 'Calcium Phosphate + Vitamin D3', mfr: 'GSK', sched: 'OTC', hsn: HSN.VITAMIN, ppu: 7.2, rank: 190, strengths: [variant('500mg+200IU', 'Calcium Phosphate 500mg + Vitamin D3 200IU')] },
  { brand: 'Becosules', generic: 'B-Complex + Vitamin C', mfr: 'Pfizer', sched: 'OTC', hsn: HSN.VITAMIN, form: 'Capsule', ppu: 3.4, rank: 880, strengths: [variant('B-Complex', 'Thiamine 10mg + Riboflavin 10mg + Niacinamide 100mg + Ascorbic Acid 150mg + Folic Acid 1.5mg')] },
  { brand: 'Becosules Z', generic: 'B-Complex + Vitamin C + Zinc', mfr: 'Pfizer', sched: 'OTC', hsn: HSN.VITAMIN, form: 'Capsule', ppu: 4.2, rank: 280, strengths: [variant('B-Complex + Zn', 'B-Complex + Ascorbic Acid 150mg + Zinc Sulphate 41.4mg')] },
  { brand: 'Neurobion Forte', generic: 'Vitamin B1 + B6 + B12', mfr: 'Merck', sched: 'OTC', hsn: HSN.VITAMIN, ppu: 4.6, rank: 920, strengths: [variant('B1+B6+B12', 'Thiamine 10mg + Pyridoxine 3mg + Cyanocobalamin 15mcg + Niacinamide 45mg')] },
  { brand: 'Neurobion Forte Injection', generic: 'Vitamin B-Complex', mfr: 'Merck', hsn: HSN.VITAMIN, form: 'Injection', packs: [pack('3ml amp', 1)], ppu: 42, rank: 130, strengths: [variant('3ml', 'Thiamine 100mg + Pyridoxine 100mg + Cyanocobalamin 1000mcg per 3ml')] },
  { brand: 'Nurokind Plus', generic: 'Mecobalamin + Alpha Lipoic Acid', mfr: 'Mankind', sched: 'OTC', hsn: HSN.VITAMIN, form: 'Capsule', ppu: 9.8, rank: 520, strengths: [variant('1500mcg+100mg', 'Mecobalamin 1500mcg + Alpha Lipoic Acid 100mg + Pyridoxine 3mg + Folic Acid 1.5mg')] },
  { brand: 'Nurokind LC', generic: 'Mecobalamin + L-Carnitine', mfr: 'Mankind', sched: 'OTC', hsn: HSN.VITAMIN, ppu: 12, rank: 240, strengths: [variant('1500mcg+500mg', 'Mecobalamin 1500mcg + L-Carnitine 500mg')] },
  { brand: 'Zincovit', generic: 'Multivitamin + Multimineral', mfr: 'Apex Laboratories', sched: 'OTC', hsn: HSN.NUTRACEUTICAL, ppu: 6.4, rank: 780, strengths: [variant('Multivitamin', 'Multivitamin, Multimineral and Grape Seed Extract with Zinc 22mg')] },
  { brand: 'Zincovit Syrup', generic: 'Multivitamin + Multimineral', salt: 'Multivitamin, multimineral and Zinc syrup', mfr: 'Apex Laboratories', sched: 'OTC', hsn: HSN.NUTRACEUTICAL, form: 'Syrup', packs: [pack('200ml', 1), pack('100ml', 1, 0.56)], ppu: 128, rank: 300, strengths: ['Multivitamin'] },
  { brand: 'Zincovit Drops', generic: 'Multivitamin + Multimineral', salt: 'Multivitamin, multimineral and Zinc paediatric drops', mfr: 'Apex Laboratories', sched: 'OTC', hsn: HSN.NUTRACEUTICAL, form: 'Drops', packs: [pack('15ml', 1)], ppu: 88, rank: 190, strengths: ['Multivitamin'] },
  { brand: 'A to Z', generic: 'Multivitamin + Multimineral', salt: 'Multivitamin and multimineral with Lycopene', mfr: 'Alkem', sched: 'OTC', hsn: HSN.NUTRACEUTICAL, ppu: 5.8, rank: 340, strengths: ['Multivitamin'] },
  { brand: 'A to Z NS', generic: 'Multivitamin + Multimineral + Antioxidants', salt: 'Multivitamin, multimineral and antioxidants with Ginseng', mfr: 'Alkem', sched: 'OTC', hsn: HSN.NUTRACEUTICAL, ppu: 8.4, rank: 200, strengths: ['Multivitamin'] },
  { brand: 'Limcee', generic: 'Ascorbic Acid', mfr: 'Abbott', sched: 'OTC', hsn: HSN.VITAMIN, packs: [pack('1x15', 15)], ppu: 1.6, rank: 620, strengths: ['500mg'] },
  { brand: 'Celin', generic: 'Ascorbic Acid', mfr: 'GSK', sched: 'OTC', hsn: HSN.VITAMIN, packs: [pack('1x15', 15), pack('1x10', 10)], ppu: 1.5, rank: 220, strengths: ['500mg'] },
  { brand: 'Uprise D3', generic: 'Cholecalciferol', mfr: 'Alkem', sched: 'OTC', hsn: HSN.VITAMIN, packs: [pack('1x4', 4), pack('1x8', 8)], ppu: 42, rank: 520, strengths: [variant('60000IU', 'Cholecalciferol 60000IU', '60K')] },
  { brand: 'Calcirol', generic: 'Cholecalciferol', mfr: 'Cadila', sched: 'OTC', hsn: HSN.VITAMIN, form: 'Sachet', packs: [pack('1 sachet', 1), pack('4 sachets', 4)], ppu: 32, rank: 380, strengths: ['60000IU'] },
  { brand: 'D-Rise', generic: 'Cholecalciferol', mfr: 'USV', sched: 'OTC', hsn: HSN.VITAMIN, form: 'Sachet', packs: [pack('1 sachet', 1), pack('4 sachets', 4)], ppu: 38, rank: 260, strengths: ['60000IU'] },
  { brand: 'Supradyn', generic: 'Multivitamin + Multimineral', salt: 'Multivitamin and multimineral with Calcium and Phosphorus', mfr: 'Bayer', sched: 'OTC', hsn: HSN.NUTRACEUTICAL, ppu: 6.8, rank: 220, strengths: ['Multivitamin'] },
  { brand: 'Revital H', generic: 'Ginseng + Multivitamin + Multimineral', mfr: 'Sun Pharma', sched: 'OTC', hsn: HSN.NUTRACEUTICAL, form: 'Capsule', packs: [pack('1x30', 30), pack('1x10', 10)], ppu: 8.2, rank: 280, strengths: [variant('Ginseng 42.5mg', 'Ginseng 42.5mg with Multivitamins and Multiminerals')] },
  { brand: 'Dexorange', generic: 'Ferric Ammonium Citrate + Cyanocobalamin + Folic Acid', mfr: 'Franco-Indian', sched: 'OTC', hsn: HSN.VITAMIN, form: 'Syrup', packs: [pack('200ml', 1), pack('100ml', 1, 0.56)], ppu: 158, rank: 240, strengths: [variant('160mg+7.5mcg+0.5mg/15ml', 'Ferric Ammonium Citrate 160mg + Cyanocobalamin 7.5mcg + Folic Acid 0.5mg per 15ml')] },
  { brand: 'Autrin', generic: 'Ferrous Fumarate + Folic Acid + B12', mfr: 'Pfizer', sched: 'OTC', hsn: HSN.VITAMIN, form: 'Capsule', ppu: 5.6, rank: 160, strengths: [variant('300mg+1.5mg', 'Ferrous Fumarate 300mg + Folic Acid 1.5mg + Cyanocobalamin 15mcg')] },
  { brand: 'Orofer XT', generic: 'Ferrous Ascorbate + Folic Acid', mfr: 'Emcure', sched: 'OTC', hsn: HSN.VITAMIN, ppu: 11, rank: 320, strengths: [variant('100mg+1.5mg', 'Ferrous Ascorbate 100mg + Folic Acid 1.5mg')] },
  { brand: 'Livogen', generic: 'Ferrous Fumarate + Folic Acid', mfr: 'Merck', sched: 'OTC', hsn: HSN.VITAMIN, ppu: 4.2, rank: 190, strengths: [variant('152mg+1.5mg', 'Ferrous Fumarate 152mg + Folic Acid 1.5mg')] },
  { brand: 'Fefol', generic: 'Ferrous Sulphate + Folic Acid', mfr: 'Abbott', sched: 'OTC', hsn: HSN.VITAMIN, form: 'Capsule', ppu: 4.8, rank: 120, strengths: [variant('150mg+0.5mg', 'Ferrous Sulphate 150mg + Folic Acid 0.5mg')] },
  { brand: 'Folvite', generic: 'Folic Acid', mfr: 'Pfizer', sched: 'OTC', hsn: HSN.VITAMIN, ppu: 1.9, rank: 280, strengths: ['5mg'] },
  { brand: 'Evion', generic: 'Vitamin E', mfr: 'Merck', sched: 'OTC', hsn: HSN.VITAMIN, form: 'Capsule', ppu: 4.4, rank: 420, strengths: ['400mg', '600mg'] },
  { brand: 'Cobadex CZS', generic: 'Multivitamin + Zinc + Selenium', mfr: 'Zydus', sched: 'OTC', hsn: HSN.NUTRACEUTICAL, form: 'Capsule', ppu: 9.2, rank: 180, strengths: [variant('Multivitamin', 'Multivitamin with Chromium, Zinc and Selenium')] },
  { brand: 'Polybion', generic: 'Vitamin B-Complex', salt: 'Vitamin B-Complex with Lysine syrup', mfr: 'Merck', sched: 'OTC', hsn: HSN.VITAMIN, form: 'Syrup', packs: [pack('200ml', 1), pack('100ml', 1, 0.56)], ppu: 118, rank: 160, strengths: ['B-Complex'] },
  { brand: 'Renerve Plus', generic: 'Methylcobalamin + Alpha Lipoic Acid', mfr: 'Pfizer', sched: 'OTC', hsn: HSN.VITAMIN, form: 'Capsule', ppu: 10.5, rank: 150, strengths: [variant('1500mcg+100mg', 'Methylcobalamin 1500mcg + Alpha Lipoic Acid 100mg')] },
  { brand: 'Protinex', generic: 'Protein Supplement', salt: 'High-protein nutritional powder with vitamins and minerals', mfr: 'Danone', sched: 'OTC', hsn: HSN.NUTRACEUTICAL, form: 'Powder', packs: [pack('400g tin', 1), pack('250g tin', 1, 0.68), pack('1kg tin', 1, 2.3)], ppu: 495, rank: 260, strengths: ['Original'] },
  { brand: 'Pediasure', generic: 'Child Nutrition Supplement', salt: 'Balanced child nutrition powder with 37 nutrients', mfr: 'Abbott', sched: 'OTC', hsn: HSN.NUTRACEUTICAL, form: 'Powder', packs: [pack('400g tin', 1), pack('200g tin', 1, 0.55)], ppu: 745, rank: 220, strengths: ['Vanilla'] },
  { brand: 'Ensure', generic: 'Adult Nutrition Supplement', salt: 'Balanced adult nutrition powder with 32 nutrients', mfr: 'Abbott', sched: 'OTC', hsn: HSN.NUTRACEUTICAL, form: 'Powder', packs: [pack('400g tin', 1), pack('200g tin', 1, 0.55)], ppu: 685, rank: 150, strengths: ['Vanilla'] },

  // --- oral rehydration. Nil-rated, and deliberately not on the 3004 default ---
  { brand: 'Electral', generic: 'Oral Rehydration Salts', mfr: 'FDC', sched: 'OTC', hsn: HSN.ORS, form: 'Powder', packs: [pack('21.8g sachet', 1), pack('4.4g sachet', 1, 0.35)], ppu: 24, rank: 980, strengths: [variant('21.8g', 'Sodium Chloride + Potassium Chloride + Sodium Citrate + Dextrose (WHO formula)')] },
  { brand: 'Enerzal', generic: 'Electrolyte Energy Drink', salt: 'Electrolyte and glucose energy drink powder', mfr: 'Wockhardt', sched: 'OTC', hsn: HSN.ORS, form: 'Powder', packs: [pack('50g sachet', 1), pack('5x50g sachet', 5)], ppu: 32, rank: 320, strengths: ['50g'] },
  { brand: 'Prolyte', generic: 'Oral Rehydration Salts', mfr: 'Cipla', sched: 'OTC', hsn: HSN.ORS, form: 'Powder', packs: [pack('21.8g sachet', 1), pack('4.4g sachet', 1, 0.35)], ppu: 22, rank: 260, strengths: [variant('21.8g', 'Sodium Chloride + Potassium Chloride + Sodium Citrate + Dextrose (WHO formula)')] },

  // --- topical and dermatology ---
  { brand: 'Betadine', generic: 'Povidone Iodine', mfr: 'Win-Medicare', sched: 'OTC', form: 'Ointment', packs: [pack('15g tube', 1), pack('20g tube', 1, 1.25)], ppu: 98, rank: 420, strengths: ['5% w/w'] },
  { brand: 'Betadine Gargle', generic: 'Povidone Iodine', mfr: 'Win-Medicare', sched: 'OTC', form: 'Syrup', packs: [pack('100ml', 1)], ppu: 148, rank: 260, strengths: ['2% w/v'] },
  { brand: 'Volini Gel', generic: 'Diclofenac Diethylamine + Methyl Salicylate + Menthol', mfr: 'Sun Pharma', sched: 'OTC', form: 'Ointment', packs: [pack('30g tube', 1), pack('50g tube', 1, 1.55), pack('15g tube', 1, 0.58)], ppu: 132, rank: 680, strengths: [variant('1.16%+10%+5%', 'Diclofenac Diethylamine 1.16% + Methyl Salicylate 10% + Menthol 5%')] },
  { brand: 'Volini Spray', generic: 'Diclofenac Diethylamine + Methyl Salicylate', mfr: 'Sun Pharma', sched: 'OTC', form: 'Ointment', packs: [pack('60g spray', 1)], ppu: 265, rank: 220, strengths: ['1.16%+10%'] },
  { brand: 'Moov', generic: 'Diclofenac Diethylamine + Mint + Nilgiri Oil', mfr: 'Reckitt Benckiser', sched: 'OTC', form: 'Ointment', ppu: 118, rank: 340, strengths: [variant('1.16%', 'Diclofenac Diethylamine 1.16% + Mint 1% + Nilgiri Oil 5%')] },
  { brand: 'Iodex', generic: 'Methyl Salicylate + Menthol', mfr: 'Reckitt Benckiser', sched: 'OTC', form: 'Ointment', ppu: 92, rank: 260, strengths: [variant('15%+6%', 'Methyl Salicylate 15% + Menthol 6%')] },
  { brand: 'Omnigel', generic: 'Diclofenac Diethylamine', mfr: 'Cipla', sched: 'OTC', form: 'Ointment', ppu: 128, rank: 240, strengths: ['1.16% w/w'] },
  { brand: 'Dynapar QPS', generic: 'Diclofenac Diethylamine', mfr: 'Troikaa', form: 'Ointment', packs: [pack('30ml spray', 1)], ppu: 158, rank: 190, strengths: ['1.16% w/v'] },
  { brand: 'Candid', generic: 'Clotrimazole', mfr: 'Glenmark', form: 'Ointment', ppu: 88, rank: 300, strengths: ['1% w/w'] },
  { brand: 'Candid Dusting Powder', generic: 'Clotrimazole', mfr: 'Glenmark', form: 'Powder', packs: [pack('100g', 1)], ppu: 132, rank: 240, strengths: ['1% w/w'] },
  { brand: 'Candid B', generic: 'Clotrimazole + Beclomethasone', mfr: 'Glenmark', form: 'Ointment', ppu: 96, rank: 280, strengths: [variant('1%+0.025%', 'Clotrimazole 1% + Beclomethasone Dipropionate 0.025%')] },
  { brand: 'Quadriderm RF', generic: 'Beclomethasone + Clotrimazole + Gentamicin', mfr: 'Merck', form: 'Ointment', ppu: 128, rank: 220, strengths: [variant('0.025%+1%+0.1%', 'Beclomethasone 0.025% + Clotrimazole 1% + Gentamicin 0.1%')] },
  { brand: 'Betnovate C', generic: 'Betamethasone + Clioquinol', mfr: 'GSK', form: 'Ointment', ppu: 68, rank: 200, strengths: [variant('0.1%+3%', 'Betamethasone Valerate 0.1% + Clioquinol 3%')] },
  { brand: 'Betnovate N', generic: 'Betamethasone + Neomycin', mfr: 'GSK', form: 'Ointment', ppu: 62, rank: 190, strengths: [variant('0.1%+0.5%', 'Betamethasone Valerate 0.1% + Neomycin 0.5%')] },
  { brand: 'Panderm Plus', generic: 'Clobetasol + Ofloxacin + Ornidazole + Terbinafine', mfr: 'Macleods', form: 'Ointment', ppu: 92, rank: 150, strengths: [variant('0.05%+0.75%+2%+1%', 'Clobetasol 0.05% + Ofloxacin 0.75% + Ornidazole 2% + Terbinafine 1%')] },
  { brand: 'Soframycin', generic: 'Framycetin Sulphate', mfr: 'Sanofi', form: 'Ointment', ppu: 58, rank: 260, strengths: ['1% w/w'] },
  { brand: 'Neosporin', generic: 'Neomycin + Bacitracin + Polymyxin B', mfr: 'GSK', form: 'Ointment', ppu: 74, rank: 190, strengths: [variant('3400IU+400IU+5000IU', 'Neomycin 3400IU + Bacitracin 400IU + Polymyxin B 5000IU per gram')] },
  { brand: 'T-Bact', generic: 'Mupirocin', mfr: 'GSK', form: 'Ointment', ppu: 168, rank: 160, strengths: ['2% w/w'] },
  { brand: 'Silverex', generic: 'Silver Sulphadiazine', mfr: 'Sun Pharma', form: 'Ointment', ppu: 112, rank: 90, strengths: ['1% w/w'] },
  { brand: 'Lulifin', generic: 'Luliconazole', mfr: 'Sun Pharma', form: 'Ointment', ppu: 185, rank: 180, strengths: ['1% w/w'] },
  { brand: 'Tenovate', generic: 'Clobetasol Propionate', mfr: 'GSK', form: 'Ointment', ppu: 82, rank: 140, strengths: ['0.05% w/w'] },
  { brand: 'Fourderm', generic: 'Clobetasol + Ofloxacin + Miconazole', mfr: 'Cipla', form: 'Ointment', ppu: 98, rank: 110, strengths: [variant('0.05%+0.75%+2%', 'Clobetasol 0.05% + Ofloxacin 0.75% + Miconazole 2%')] },
  { brand: 'Ring Guard', generic: 'Clotrimazole + Menthol', mfr: 'Reckitt Benckiser', sched: 'OTC', form: 'Ointment', ppu: 68, rank: 200, strengths: [variant('1%+1%', 'Clotrimazole 1% + Menthol 1%')] },
  { brand: 'Itch Guard', generic: 'Clotrimazole', mfr: 'Reckitt Benckiser', sched: 'OTC', form: 'Ointment', ppu: 72, rank: 180, strengths: ['1% w/w'] },
  { brand: 'Cetaphil Cleansing Lotion', generic: 'Skin Cleanser', salt: 'Soap-free gentle skin cleansing lotion', mfr: 'Galderma', sched: 'OTC', hsn: HSN.COSMETIC, form: 'Other', uom: 'BOTTLE', packs: [pack('125ml', 1), pack('250ml', 1, 1.8)], ppu: 425, rank: 220, strengths: ['125ml'] },
  { brand: 'Venusia Max', generic: 'Emollient Moisturiser', salt: 'Intensive emollient with Shea Butter and Vitamin E', mfr: "Dr Reddy's", sched: 'OTC', hsn: HSN.COSMETIC, form: 'Other', uom: 'TUBE', packs: [pack('300g', 1), pack('75g', 1, 0.38)], ppu: 545, rank: 190, strengths: ['300g'] },
  { brand: 'Moisturex', generic: 'Urea + Lactic Acid Moisturiser', salt: 'Urea 10% + Lactic Acid 10% emollient cream', mfr: 'Sun Pharma', sched: 'OTC', hsn: HSN.COSMETIC, form: 'Other', uom: 'TUBE', packs: [pack('75g', 1), pack('150g', 1, 1.8)], ppu: 295, rank: 140, strengths: ['75g'] },
  { brand: 'Suncros', generic: 'Sunscreen SPF 50', salt: 'Broad-spectrum sunscreen SPF 50+ PA+++', mfr: 'Ajanta', sched: 'OTC', hsn: HSN.COSMETIC, form: 'Other', uom: 'TUBE', packs: [pack('60g', 1)], ppu: 385, rank: 130, strengths: ['SPF 50+'] },

  // --- eye and ear ---
  { brand: 'Moxicip', generic: 'Moxifloxacin', mfr: 'Cipla', hsn: HSN.ANTIBIOTIC, form: 'Drops', packs: [pack('5ml', 1)], ppu: 68, rank: 220, strengths: ['0.5% w/v'] },
  { brand: 'Milflox', generic: 'Moxifloxacin', mfr: 'Sun Pharma', hsn: HSN.ANTIBIOTIC, form: 'Drops', packs: [pack('5ml', 1)], ppu: 72, rank: 160, strengths: ['0.5% w/v'] },
  { brand: 'Ciplox Eye', generic: 'Ciprofloxacin', mfr: 'Cipla', hsn: HSN.ANTIBIOTIC, form: 'Drops', packs: [pack('10ml', 1)], ppu: 22, rank: 180, strengths: ['0.3% w/v'] },
  { brand: 'Refresh Tears', generic: 'Carboxymethylcellulose', mfr: 'Allergan', sched: 'OTC', form: 'Drops', packs: [pack('10ml', 1)], ppu: 165, rank: 240, strengths: ['0.5% w/v'] },
  { brand: 'Systane', generic: 'Polyethylene Glycol + Propylene Glycol', mfr: 'Alcon', sched: 'OTC', form: 'Drops', packs: [pack('10ml', 1)], ppu: 285, rank: 190, strengths: [variant('0.4%+0.3%', 'Polyethylene Glycol 400 0.4% + Propylene Glycol 0.3%')] },
  { brand: 'Candibiotic', generic: 'Chloramphenicol + Beclomethasone + Clotrimazole + Lignocaine', mfr: 'Glenmark', form: 'Drops', packs: [pack('5ml', 1)], ppu: 128, rank: 200, strengths: [variant('5%+0.025%+1%+2%', 'Chloramphenicol 5% + Beclomethasone 0.025% + Clotrimazole 1% + Lignocaine 2%')] },
  { brand: 'Waxolve', generic: 'Paradichlorobenzene + Benzocaine + Turpentine Oil', mfr: 'Cipla', sched: 'OTC', form: 'Drops', packs: [pack('10ml', 1)], ppu: 78, rank: 150, strengths: [variant('2%+2.7%+15%', 'Paradichlorobenzene 2% + Benzocaine 2.7% + Turpentine Oil 15%')] },

  // --- antifungal, antiviral, antiparasitic ---
  { brand: 'Forcan', generic: 'Fluconazole', mfr: 'Cipla', packs: [pack('1x1', 1), pack('1x4', 4), pack('1x10', 10)], ppu: 22, rank: 190, strengths: ['150mg', '200mg', '50mg'] },
  { brand: 'Zocon', generic: 'Fluconazole', mfr: 'FDC', packs: [pack('1x1', 1), pack('1x4', 4)], ppu: 20, rank: 150, strengths: ['150mg', '200mg'] },
  { brand: 'Itaspor', generic: 'Itraconazole', mfr: 'Intas', form: 'Capsule', ppu: 32, rank: 130, strengths: ['100mg', '200mg'] },
  { brand: 'Terbinaforce', generic: 'Terbinafine', mfr: 'Mankind', ppu: 14, rank: 180, strengths: ['250mg', '500mg'] },
  { brand: 'Valcivir', generic: 'Valacyclovir', mfr: 'Cipla', ppu: 68, rank: 90, strengths: ['500mg', '1000mg'] },
  { brand: 'Acivir', generic: 'Acyclovir', mfr: 'Cipla', ppu: 12, rank: 110, strengths: ['400mg', '800mg', '200mg'] },
  { brand: 'Fluvir', generic: 'Oseltamivir', mfr: 'Hetero', form: 'Capsule', ppu: 48, rank: 60, strengths: ['75mg'] },
  { brand: 'Zentel', generic: 'Albendazole', mfr: 'GSK', packs: SINGLE_TAB, ppu: 22, rank: 320, strengths: ['400mg'] },
  { brand: 'Bandy', generic: 'Albendazole', mfr: 'Mankind', packs: SINGLE_TAB, ppu: 18, rank: 220, strengths: ['400mg'] },
  { brand: 'Ivermectol', generic: 'Ivermectin', mfr: 'Sun Pharma', packs: [pack('1x2', 2), pack('1x10', 10)], ppu: 24, rank: 140, strengths: ['12mg', '6mg'] },
  { brand: 'Lariago', generic: 'Chloroquine Phosphate', mfr: 'Ipca', ppu: 3.4, rank: 90, strengths: ['250mg', '500mg'] },
  { brand: 'Falcigo', generic: 'Artesunate', mfr: 'Zydus', form: 'Injection', packs: VIAL_ONLY, ppu: 210, rank: 25, strengths: ['60mg'] },

  // --- urology, gout, miscellaneous ---
  { brand: 'Zyloric', generic: 'Allopurinol', mfr: 'GSK', ppu: 3.2, rank: 130, strengths: ['100mg', '300mg'] },
  { brand: 'Febustat', generic: 'Febuxostat', mfr: 'Sun Pharma', ppu: 14, rank: 190, strengths: ['40mg', '80mg'] },
  { brand: 'Urimax', generic: 'Tamsulosin', mfr: 'Cipla', form: 'Capsule', ppu: 12, rank: 280, strengths: ['0.4mg', '0.2mg'] },
  { brand: 'Urimax D', generic: 'Tamsulosin + Dutasteride', mfr: 'Cipla', ppu: 18, rank: 220, strengths: [variant('0.4mg+0.5mg', 'Tamsulosin 0.4mg + Dutasteride 0.5mg')] },
  { brand: 'Veltam', generic: 'Tamsulosin', mfr: 'Intas', form: 'Capsule', ppu: 11, rank: 140, strengths: ['0.4mg'] },
  { brand: 'Dutas', generic: 'Dutasteride', mfr: "Dr Reddy's", form: 'Capsule', ppu: 16, rank: 120, strengths: ['0.5mg'] },
  { brand: 'Alkasol', generic: 'Disodium Hydrogen Citrate', mfr: 'Stadmed', form: 'Syrup', packs: [pack('100ml', 1), pack('200ml', 1, 1.8)], ppu: 145, rank: 190, strengths: ['1.53g/5ml'] },
  { brand: 'Cital', generic: 'Disodium Hydrogen Citrate', mfr: 'Alkem', form: 'Syrup', packs: [pack('100ml', 1), pack('200ml', 1, 1.8)], ppu: 138, rank: 150, strengths: ['1.53g/5ml'] },

  // --- surgical, devices, diagnostics. Not one of these is on a 3004 heading ---
  { brand: 'Band-Aid', generic: 'Adhesive Bandage', salt: 'Sterile adhesive wound dressing, washproof', mfr: 'Johnson & Johnson', sched: 'OTC', form: 'Surgical', hsn: HSN.ADHESIVE_DRESSING, packs: [pack('10 strips', 10), pack('20 strips', 20)], ppu: 4, rank: 340, strengths: ['Washproof'] },
  { brand: 'Hansaplast', generic: 'Adhesive Bandage', salt: 'Sterile adhesive wound dressing, washproof', mfr: 'Beiersdorf', sched: 'OTC', form: 'Surgical', hsn: HSN.ADHESIVE_DRESSING, packs: [pack('10 strips', 10), pack('20 strips', 20)], ppu: 3.6, rank: 220, strengths: ['Washproof'] },
  { brand: 'Micropore', generic: 'Surgical Adhesive Tape', salt: 'Hypoallergenic non-woven surgical adhesive tape', mfr: '3M', sched: 'OTC', form: 'Surgical', hsn: HSN.ADHESIVE_DRESSING, packs: [pack('1 roll', 1)], ppu: 68, rank: 200, strengths: ['1 inch x 9m'] },
  { brand: 'Absorbent Cotton', generic: 'Cotton Wool IP', salt: 'Absorbent cotton wool IP, non-sterile', mfr: 'Bengal Chemicals', sched: 'OTC', form: 'Surgical', hsn: HSN.DRESSING, packs: [pack('500g roll', 1), pack('100g roll', 1, 0.28)], ppu: 68, rank: 280, strengths: ['500g'] },
  { brand: 'Roller Bandage', generic: 'Cotton Bandage IP', salt: 'Cotton roller bandage IP', mfr: 'Datt Mediproducts', sched: 'OTC', form: 'Surgical', hsn: HSN.DRESSING, packs: [pack('1 roll', 1)], ppu: 22, rank: 240, strengths: ['10cm x 4m'] },
  { brand: 'Gauze Swab', generic: 'Sterile Gauze IP', salt: 'Sterile absorbent gauze swab IP, 8 ply', mfr: 'Datt Mediproducts', sched: 'OTC', form: 'Surgical', hsn: HSN.DRESSING, packs: [pack('10 pcs', 10)], ppu: 3.2, rank: 180, strengths: ['10cm x 10cm'] },
  { brand: 'Dispovan', generic: 'Disposable Syringe', mfr: 'HMD', sched: 'OTC', form: 'Device', hsn: HSN.SYRINGE, packs: [pack('1 pc', 1), pack('100 pcs', 100)], ppu: 6.5, rank: 320, strengths: [variant('5ml', 'Disposable syringe with needle, 5ml', '5ml'), variant('2ml', 'Disposable syringe with needle, 2ml', '2ml'), variant('10ml', 'Disposable syringe with needle, 10ml', '10ml')] },
  { brand: 'Accu-Chek Active Strips', generic: 'Blood Glucose Test Strip', salt: 'Blood glucose test strip, glucose dehydrogenase', mfr: 'Roche', sched: 'OTC', form: 'Device', hsn: HSN.DIAGNOSTIC, packs: [pack('50 strips', 50), pack('25 strips', 25)], ppu: 21, rank: 260, strengths: ['50 strips'] },
  { brand: 'OneTouch Select Plus Strips', generic: 'Blood Glucose Test Strip', salt: 'Blood glucose test strip, glucose oxidase', mfr: 'LifeScan', sched: 'OTC', form: 'Device', hsn: HSN.DIAGNOSTIC, packs: [pack('50 strips', 50), pack('25 strips', 25)], ppu: 24, rank: 190, strengths: ['50 strips'] },
  { brand: 'Prega News', generic: 'Pregnancy Test Kit', salt: 'Rapid hCG urine pregnancy test card', mfr: 'Mankind', sched: 'OTC', form: 'Device', hsn: HSN.DIAGNOSTIC, packs: [pack('1 kit', 1)], ppu: 55, rank: 300, strengths: ['Single use'] },
  { brand: 'i-can', generic: 'Pregnancy Test Kit', salt: 'Rapid hCG urine pregnancy test card', mfr: 'Piramal', sched: 'OTC', form: 'Device', hsn: HSN.DIAGNOSTIC, packs: [pack('1 kit', 1)], ppu: 48, rank: 190, strengths: ['Single use'] },
  { brand: 'Dr Morepen Glucometer', generic: null, salt: 'Blood glucose monitoring system, capillary whole blood', mfr: 'Morepen', sched: 'OTC', form: 'Device', hsn: HSN.INSTRUMENT, packs: UNIT_PACKS, ppu: 950, rank: 60, strengths: ['BG-03'] },
  { brand: 'Omron BP Monitor', generic: null, salt: 'Digital blood pressure monitor, upper arm, oscillometric', mfr: 'Omron Healthcare', sched: 'OTC', form: 'Device', hsn: HSN.INSTRUMENT, packs: UNIT_PACKS, ppu: 2450, rank: 45, strengths: ['HEM-7124'] },
  { brand: 'Digital Thermometer', generic: null, salt: 'Digital clinical thermometer, oral and axillary', mfr: 'Morepen', sched: 'OTC', form: 'Device', hsn: HSN.THERMOMETER, packs: UNIT_PACKS, ppu: 165, rank: 180, strengths: ['MT-100'] },

  // --- unbranded generics. 3003 headings: not put up in measured doses for retail sale ---
  { brand: 'Paracetamol IP', generic: 'Paracetamol', mfr: 'Generic (Jan Aushadhi)', sched: 'OTC', hsn: HSN.BULK, packs: [pack('1x10', 10), pack('10x10', 10)], ppu: 0.42, rank: 280, strengths: ['650mg', '500mg'] },
  { brand: 'Metformin HCl IP', generic: 'Metformin', mfr: 'Generic (Jan Aushadhi)', hsn: HSN.BULK, packs: [pack('1x10', 10), pack('10x10', 10)], ppu: 0.55, rank: 190, strengths: ['500mg', '1000mg'] },
  { brand: 'Amoxycillin IP', generic: 'Amoxycillin', mfr: 'Generic (Jan Aushadhi)', hsn: HSN.BULK_ANTIBIOTIC, form: 'Capsule', packs: [pack('1x10', 10)], ppu: 2.1, rank: 140, strengths: ['500mg', '250mg'] },
  { brand: 'Cetirizine IP', generic: 'Cetirizine', mfr: 'Generic (Jan Aushadhi)', hsn: HSN.BULK, packs: [pack('1x10', 10), pack('10x10', 10)], ppu: 0.38, rank: 160, strengths: ['10mg'] },
  { brand: 'Oral Rehydration Salts IP', generic: 'Oral Rehydration Salts', mfr: 'Generic (Jan Aushadhi)', sched: 'OTC', hsn: HSN.ORS, form: 'Powder', packs: [pack('21.8g sachet', 1), pack('10 sachets', 10)], ppu: 11, rank: 220, strengths: [variant('21.8g', 'Sodium Chloride + Potassium Chloride + Sodium Citrate + Dextrose (WHO formula)')] },
  { brand: 'Povidone Iodine IP', generic: 'Povidone Iodine', mfr: 'Generic (Jan Aushadhi)', sched: 'OTC', hsn: HSN.BULK, form: 'Ointment', packs: [pack('15g tube', 1)], ppu: 42, rank: 120, strengths: ['5% w/w'] },
]

// -------------------------------------------------------------- expansion ---

const RACK_ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const

/** Steep, not flat. Search ranking is driven by saleRank and a flat tail feels wrong. */
const STRENGTH_DECAY = [1, 0.55, 0.3, 0.18, 0.11, 0.07, 0.05] as const
const PACK_DECAY = [1, 0.45, 0.2] as const

/** "Telma 40", not "Telma 40mg". Anything that is not a bare mg/mcg dose stays whole. */
function nameSuffix(strength: string): string {
  const m = /^([\d.]+)(?:mg|mcg)$/.exec(strength)
  return m?.[1] ?? strength
}

function normalise(x: string | StrengthSpec, salt: string): StrengthSpec {
  return typeof x === 'string' ? { s: x, c: salt.replace('{}', x) } : x
}

/**
 * Pack MRP in paise, keyed by SKU. `generateBatches` takes only `SeedMedicine`,
 * whose shape the contract fixes, so the price the master was built from has to
 * be carried out of band rather than smuggled into an extra field.
 */
const MRP_BY_SKU = new Map<string, number>()

function skuKey(m: Pick<SeedMedicine, 'manufacturer' | 'brandName' | 'strengthText' | 'packLabel'>): string {
  return `${m.manufacturer}|${m.brandName}|${m.strengthText}|${m.packLabel}`
}

function expand(): SeedMedicine[] {
  const rnd = mulberry32(0x52784231)
  const prefixes = new Map<string, string>()
  const out: SeedMedicine[] = []

  for (const [bi, b] of BRANDS.entries()) {
    const form = b.form ?? 'Tablet'
    const sched = b.sched ?? 'H'
    const uom = b.uom ?? DEFAULT_UOM[form]
    const packs = b.packs ?? DEFAULT_PACKS[form]
    const salt = b.salt ?? `${b.generic ?? b.brand} {}`
    // The contract notes that H1 and injections generally may not be cut, so a
    // schedule change is what flips loose sale — not a per-row opinion.
    const loose = b.loose ?? ((form === 'Tablet' || form === 'Capsule') && sched !== 'X' && sched !== 'H1')
    const rack = b.cold === true
      ? `COLD-${1 + (bi % 4)}`
      : `${RACK_ROWS[bi % 8] ?? 'A'}-${1 + (Math.floor(bi / 8) % 8)}`

    for (const [si, rawStrength] of b.strengths.entries()) {
      const st = normalise(rawStrength, salt)
      const suffix = st.n ?? (b.strengths.length > 1 ? nameSuffix(st.s) : '')
      const brandName = suffix === '' ? b.brand : `${b.brand} ${suffix}`

      const spread = rnd()
      const packCount = Math.min(
        packs.length,
        si === 0 ? (spread < 0.55 ? 4 : 3) : spread < 0.35 ? 3 : spread < 0.85 ? 2 : 1,
      )

      for (let k = 0; k < packCount; k++) {
        const p = packs[(si * 2 + k) % packs.length]
        if (p === undefined) continue

        const rank = Math.max(0, Math.round(
          b.rank * (STRENGTH_DECAY[si] ?? 0.04) * (PACK_DECAY[k] ?? 0.12) * (0.82 + rnd() * 0.42),
        ))
        const paise = scaleUp(b.ppu * p.units * p.f * (1 + 0.28 * si) * (0.94 + rnd() * 0.12), 2)

        const coarse = uom === 'TAB' || uom === 'CAP'
          ? clamp(Math.round(rank / 14), 10, 200)
          : clamp(Math.round(rank / 50), 2, 40)

        const barcodes: string[] = []
        if (rnd() < 0.6) {
          let prefix = prefixes.get(b.mfr)
          if (prefix === undefined) {
            prefix = String(2000 + prefixes.size)
            prefixes.set(b.mfr, prefix)
          }
          barcodes.push(ean13(`890${prefix}${String(out.length + 1).padStart(5, '0')}`))
        }

        const medicine: SeedMedicine = {
          brandName,
          genericName: b.generic,
          compositionText: st.c,
          manufacturer: b.mfr,
          form,
          strengthText: st.s,
          packLabel: p.label,
          unitsPerPack: p.units,
          baseUom: uom,
          allowLooseSale: loose,
          saleStep: b.step !== undefined && loose ? b.step : '1',
          hsnCode: b.hsn ?? HSN.ALLOPATHIC,
          drugSchedule: sched,
          requiresPrescription: sched !== 'OTC',
          rackLocation: rnd() < 0.04 ? null : rack,
          reorderLevel: coarse > 20 ? Math.round(coarse / 5) * 5 : coarse,
          barcodes,
          saleRank: rank,
        }
        MRP_BY_SKU.set(skuKey(medicine), paise)
        out.push(medicine)
      }
    }
  }
  return out
}

export const SEED_MEDICINES: SeedMedicine[] = expand()

// ---------------------------------------------------------------- batches ---

const EXPIRY_BUCKETS = ['expired', 'd30', 'd60', 'd90', 'd180', 'ok'] as const
type ExpiryBucket = (typeof EXPIRY_BUCKETS)[number]

/** Percentages. The near-expiry board and the expiry chips need real data in every band. */
const EXPIRY_MIX: Record<ExpiryBucket, number> = { expired: 4, d30: 5, d60: 6, d90: 8, d180: 14, ok: 63 }

interface ExpiryCalendar {
  readonly byBucket: Record<ExpiryBucket, IsoDate[]>
  /** Always populated, so a draw never has to invent a date. */
  readonly far: IsoDate
}

/**
 * Buckets are built by CLASSIFYING real month-end dates, not by picking a day
 * offset and snapping it: snapping moves a date across a bucket boundary
 * (a 25-day offset in a 40-day month lands in the 60-day band) and skews the mix.
 */
function buildExpiryCalendar(today: Date): ExpiryCalendar {
  const byBucket: Record<ExpiryBucket, IsoDate[]> = {
    expired: [], d30: [], d60: [], d90: [], d180: [], ok: [],
  }
  for (let offset = -30; offset <= 42; offset++) {
    const iso = endOfMonth(today.getFullYear(), today.getMonth() + offset)
    const d = daysBetween(today, iso)
    const bucket: ExpiryBucket =
      d < 0 ? 'expired' : d <= 30 ? 'd30' : d <= 60 ? 'd60' : d <= 90 ? 'd90' : d <= 180 ? 'd180' : 'ok'
    byBucket[bucket].push(iso)
  }
  return { byBucket, far: endOfMonth(today.getFullYear(), today.getMonth() + 30) }
}

/**
 * Month-ends are 28–31 days apart and a band is 30 days wide, so a band can
 * contain no month-end at all: seeded on 2026-03-01 nothing expires 61–90 days
 * out, and on 2026-03-31 nothing expires 31–60 days out. Falling through to
 * `far` there would fling that band's entire share 30 months forward and leave
 * the near-expiry board empty on the one day it is being demoed, so an empty
 * band borrows from the closest populated one instead.
 */
function bandDates(cal: ExpiryCalendar, i: number): readonly IsoDate[] {
  for (let step = 0; step < EXPIRY_BUCKETS.length; step++) {
    for (const j of [i - step, i + step]) {
      const b = EXPIRY_BUCKETS[j]
      if (b !== undefined && cal.byBucket[b].length > 0) return cal.byBucket[b]
    }
  }
  return []
}

function drawExpiry(rnd: () => number, cal: ExpiryCalendar): IsoDate {
  let roll = rnd() * 100
  for (const [i, bucket] of EXPIRY_BUCKETS.entries()) {
    roll -= EXPIRY_MIX[bucket]
    if (roll < 0) return pick(rnd, bandDates(cal, i)) ?? cal.far
  }
  return cal.far
}

/** Pharma month codes skip I, which is too easily read as 1. */
const MONTH_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M'] as const

/** Five house styles, because no two suppliers print batch numbers the same way. */
function batchNumber(rnd: () => number, brandName: string, expiry: IsoDate): string {
  const letters = brandName.toUpperCase().replace(/[^A-Z]/g, '')
  const tag = letters.slice(0, 2) === '' ? 'RX' : letters.slice(0, 2)
  const mfg = new Date(Date.UTC(
    Number(expiry.slice(0, 4)) - 2,
    Number(expiry.slice(5, 7)) - 1,
    1 + Math.floor(rnd() * 27),
  ))
  const yy = String(mfg.getUTCFullYear() % 100).padStart(2, '0')
  const mm = String(mfg.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(mfg.getUTCDate()).padStart(2, '0')
  const serial = String(1000 + Math.floor(rnd() * 8999))
  switch (Math.floor(rnd() * 5)) {
    case 0: return `B-${serial}`
    case 1: return `${tag}${serial}`
    case 2: return `T${yy}${mm}${dd}`
    case 3: return `${yy}${MONTH_CODES[mfg.getUTCMonth()] ?? 'A'}${dd}${tag.slice(0, 1)}`
    default: return `${tag}-${yy}${serial.slice(0, 3)}`
  }
}

/** Held as half-units so a 0.5 remainder never goes through a float. */
function qtyString(halves: number): Qty {
  return halves % 2 === 0 ? String(halves / 2) : `${(halves - 1) / 2}.5`
}

/** Whole units, never halves: an odd share would put a 0.5 on a saleStep '1' SKU. */
function splitUnits(rnd: () => number, total: number, parts: number): number[] {
  const weights = Array.from({ length: parts }, () => 0.4 + rnd())
  const sum = weights.reduce((a, w) => a + w, 0)
  const shares = weights.map((w) => Math.floor((total * w) / sum))
  const assigned = shares.reduce((a, s) => a + s, 0)
  shares[0] = (shares[0] ?? 0) + (total - assigned)
  return shares
}

export function generateBatches(
  medicines: Array<SeedMedicine & { id: number }>,
  today: Date,
): Array<Omit<Batch, 'id' | 'storeId'>> {
  const rnd = mulberry32(0x0ba7c4e5)
  const cal = buildExpiryCalendar(today)
  const out: Array<Omit<Batch, 'id' | 'storeId'>> = []

  // Two live batches at two printed MRPs is the case the batch-chip strip and
  // the MRP-reprice warning exist for. It is forced onto the fast movers rather
  // than left to the dice, so the demo cannot come up without it.
  const twoLiveMrps = new Set(
    [...medicines]
      .sort((a, b) => b.saleRank - a.saleRank || a.id - b.id)
      .slice(0, 60)
      .map((m) => m.id),
  )

  for (const m of medicines) {
    const basePaise = MRP_BY_SKU.get(skuKey(m)) ?? scaleUp(m.unitsPerPack * 5, 2)
    const headingGst = GST_BY_HSN[m.hsnCode] ?? '5'
    const dual = twoLiveMrps.has(m.id)

    const stockRoll = rnd()
    const magnitude = rnd()
    const spread = rnd()
    const count = dual ? 2 : spread < 0.55 ? 1 : spread < 0.9 ? 2 : 3

    const level = m.reorderLevel
    const units = dual || stockRoll >= 0.12
      ? Math.round(level * (1.4 + magnitude * 4.6))
      : stockRoll < 0.032
        ? 0
        : Math.max(1, Math.round(level * (0.15 + magnitude * 0.6)))
    const remainder = units > 0 && m.saleStep === '0.5' && rnd() < 0.35 ? 1 : 0

    // A dual medicine must stay demonstrable: both batches live, both stocked,
    // the older one carrying the older (lower) printed MRP.
    const dualLead = Math.max(1, Math.floor(units * (0.35 + rnd() * 0.3)))
    const shares = dual
      ? [dualLead, Math.max(1, units - dualLead)]
      : splitUnits(rnd, units, count)
    const dualExpiries = dual
      ? [pick(rnd, cal.byBucket.ok) ?? cal.far, pick(rnd, cal.byBucket.ok) ?? cal.far].sort()
      : []

    for (let bi = 0; bi < count; bi++) {
      const expiry = dual ? dualExpiries[bi] ?? cal.far : drawExpiry(rnd, cal)
      const drift = dual ? (bi === 0 ? 0.93 : 1) : 0.97 + rnd() * 0.06
      let paise = Math.round(basePaise * drift)
      if (dual && bi === 1 && paise === Math.round(basePaise * 0.93)) paise += 25

      const gstPct: Pct = headingGst === '5' && rnd() < 0.13 ? '12' : headingGst
      const unit10k = Math.round((paise * 100) / m.unitsPerPack)
      const ptr10k = Math.max(1, Math.round((unit10k / gstDivisor(gstPct)) * (1 - (0.16 + rnd() * 0.06))))
      const landed10k = Math.max(1, Math.min(ptr10k - 1, Math.round(ptr10k * (1 - (0.01 + rnd() * 0.05)))))

      out.push({
        medicineId: m.id,
        batchNo: batchNumber(rnd, m.brandName, expiry),
        expiryDate: expiry,
        mrpPerPack: fixed(paise, 2),
        mrpPerUnit: fixed(unit10k, 4),
        ptrPerUnit: fixed(ptr10k, 4),
        landedCostPerUnit: fixed(landed10k, 4),
        purchaseGstPct: gstPct,
        qtyOnHand: qtyString((shares[bi] ?? 0) * 2 + (bi === 0 ? remainder : 0)),
        isQuarantined: !dual && rnd() < 0.025,
      })
    }
  }
  return out
}
