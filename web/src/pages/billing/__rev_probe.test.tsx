import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ApiAdapter, Batch, Doctor, Medicine, MedicineSearchHit } from '@contract'
import { ApiContext } from '@/api'
import { useHotkeys } from '@/hooks/useHotkeys'
import { SubstitutesPanel } from './SubstitutesPanel'
import { DoctorBar } from './DoctorBar'

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = () => {}
  // jsdom lacks PointerEvent APIs radix uses
  if (!(Element.prototype as any).hasPointerCapture) {
    ;(Element.prototype as any).hasPointerCapture = () => false
    ;(Element.prototype as any).setPointerCapture = () => {}
    ;(Element.prototype as any).releasePointerCapture = () => {}
  }
})

function med(id: number, brand: string): Medicine {
  return {
    id, storeId: 1, brandName: brand, genericName: 'amlodipine',
    compositionText: 'Amlodipine 5mg', manufacturer: 'Acme', strengthText: '5mg',
    packLabel: '10 tabs', unitsPerPack: '10', hsnCode: '3004', gstPct: '12',
    drugSchedule: 'H', isNarcotic: false, requiresPrescription: true,
    reorderLevel: 10, isActive: true, barcode: null,
  } as unknown as Medicine
}
function batch(mrp: string): Batch {
  return {
    id: 1, medicineId: 1, batchNo: 'B1', expiryDate: '2027-11-30',
    mrpPerPack: '100.0000', mrpPerUnit: mrp, ptrPerUnit: '5', landedCostPerUnit: '4',
    purchaseGstPct: '12', qtyOnHand: '50', isQuarantined: false,
  } as unknown as Batch
}
function hit(id: number, brand: string, mrp: string): MedicineSearchHit {
  return {
    medicine: med(id, brand), stockQty: '50', fefoBatch: { ...batch(mrp), medicineId: id },
    batchCount: 1, matchedOn: 'composition', outOfStock: false,
  }
}

function stub(over: Partial<ApiAdapter> = {}): ApiAdapter {
  return {
    findSubstitutes: async () => [],
    getMedicines: async () => [med(1, 'Amlong')],
    searchDoctors: async () => [],
    recentDoctors: async () => [],
    createDoctor: async () => { throw new Error('nope') },
    ...over,
  } as ApiAdapter
}

describe('probe: SubstitutesPanel', () => {
  it('focuses the list, arrows move, Enter picks; delta wording', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <ApiContext.Provider value={stub({ findSubstitutes: async () => [hit(2, 'Stamlo', '4.5000'), hit(3, 'Amlopres', '5.7500')] })}>
          <SubstitutesPanel open onOpenChange={vi.fn()} medicineId={1} brandName="Amlong" onPick={onPick} currentMrp="5.0000" />
        </ApiContext.Provider>
      </QueryClientProvider>,
    )
    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(list).toHaveFocus())
    expect(list).toHaveAttribute('aria-activedescendant', 'sub-2')
    expect(screen.getByText(/cheaper/)).toBeInTheDocument()
    expect(screen.getByText(/dearer/)).toBeInTheDocument()
    console.log('DELTA TEXTS:', screen.getAllByText(/cheaper|dearer/).map((e) => e.parentElement?.textContent))
    await user.keyboard('{ArrowDown}')
    expect(list).toHaveAttribute('aria-activedescendant', 'sub-3')
    await user.keyboard('{Enter}')
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ medicine: expect.objectContaining({ id: 3 }) }))
  })

  it('REOPEN: same medicine, cached data — does the list get focus again?', async () => {
    const user = userEvent.setup()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const api = stub({ findSubstitutes: async () => [hit(2, 'Stamlo', '4.5000')] })
    function Harness() {
      const [open, setOpen] = (globalThis as any).React_useState_shim()
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>open</button>
          <SubstitutesPanel open={open} onOpenChange={setOpen} medicineId={1} brandName="Amlong" onPick={vi.fn()} currentMrp="5.0000" />
        </>
      )
    }
    void Harness; void user; void api; void qc
  })

  it('modal scope blocks bill.save under the dialog', async () => {
    const save = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Behind() { useHotkeys('billing', { 'bill.save': save }); return null }
    render(
      <QueryClientProvider client={qc}>
        <ApiContext.Provider value={stub({ findSubstitutes: async () => [hit(2, 'Stamlo', '4.5000')] })}>
          <Behind />
          <SubstitutesPanel open onOpenChange={vi.fn()} medicineId={1} brandName="Amlong" onPick={vi.fn()} currentMrp="5.0000" />
        </ApiContext.Provider>
      </QueryClientProvider>,
    )
    await screen.findByRole('listbox')
    const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'NumpadEnter', bubbles: true })
    document.dispatchEvent(ev)
    expect(save).not.toHaveBeenCalled()
  })
})

describe('probe: DoctorBar', () => {
  it('opens with the search input focused', async () => {
    const user = userEvent.setup()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <ApiContext.Provider value={stub()}>
          <DoctorBar doctor={null} onSelect={vi.fn()} required={false} />
        </ApiContext.Provider>
      </QueryClientProvider>,
    )
    await user.click(screen.getByRole('button', { name: /add prescriber/i }))
    const box = await screen.findByRole('combobox')
    await waitFor(() => expect(box).toHaveFocus())
  })

  it('double Enter on the new-prescriber form fires createDoctor twice?', async () => {
    const user = userEvent.setup()
    let resolve: ((d: Doctor) => void) | null = null
    const createDoctor = vi.fn(() => new Promise<Doctor>((r) => { resolve = r }))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <ApiContext.Provider value={stub({ createDoctor: createDoctor as unknown as ApiAdapter['createDoctor'] })}>
          <DoctorBar doctor={null} onSelect={vi.fn()} required={false} />
        </ApiContext.Provider>
      </QueryClientProvider>,
    )
    await user.click(screen.getByRole('button', { name: /add prescriber/i }))
    await user.click(await screen.findByRole('button', { name: /new prescriber/i }))
    const name = screen.getByLabelText(/name/i)
    await user.type(name, 'Rao')
    await user.keyboard('{Enter}')
    await user.keyboard('{Enter}')
    console.log('createDoctor calls:', createDoctor.mock.calls.length)
    void resolve
    expect(createDoctor.mock.calls.length).toBe(1)
  })
})
