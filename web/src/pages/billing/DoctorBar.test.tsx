import type { ComponentProps } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ApiAdapter, Doctor } from '@contract'
import { ApiContext } from '@/api'
import { useHotkeys } from '@/hooks/useHotkeys'
import { DoctorBar } from './DoctorBar'

const DR: Doctor = {
  id: 7,
  storeId: 1,
  name: 'A. K. Rao',
  registrationNo: 'KMC/12345',
  qualification: 'MBBS, MD',
  clinicName: 'Rao Clinic',
  phone: '9876500001',
  prescriptionCount: 42,
}

/** Only the three doctor calls exist; anything else this component reaches for is a bug. */
function stubApi(over: Partial<ApiAdapter> = {}): ApiAdapter {
  return {
    searchDoctors: async () => [],
    recentDoctors: async () => [],
    createDoctor: async () => { throw new Error('createDoctor: not stubbed') },
    ...over,
  } as ApiAdapter
}

function renderBar(api: ApiAdapter, props: Partial<ComponentProps<typeof DoctorBar>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ApiContext.Provider value={api}>
        <DoctorBar doctor={null} onSelect={vi.fn()} required={false} {...props} />
      </ApiContext.Provider>
    </QueryClientProvider>,
  )
}

beforeAll(() => {
  /* Radix positions the popover with ResizeObserver and scrolls the highlighted
     row into view; jsdom implements neither, and without them every popover test
     fails on the environment rather than on the component. */
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  Element.prototype.scrollIntoView = () => {}
})

describe('DoctorBar', () => {
  it('says "required" in words, not in colour alone', () => {
    renderBar(stubApi(), { required: true })

    /* Queried by ACCESSIBLE NAME on purpose: that is the assertion that the
       requirement survives for an operator who cannot separate the magenta. */
    expect(screen.getByRole('button', { name: /required/i })).toBeInTheDocument()
  })

  it('hands the picked prescriber back whole', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    renderBar(stubApi({ recentDoctors: async () => [DR] }), { onSelect })

    await user.click(screen.getByRole('button', { name: /add prescriber/i }))
    await user.click(await screen.findByText('Dr A. K. Rao'))

    expect(onSelect).toHaveBeenCalledWith(DR)
  })

  it('refuses a new prescriber with no name, and says why', async () => {
    const user = userEvent.setup()
    const createDoctor = vi.fn(async () => DR)
    renderBar(stubApi({ createDoctor }))

    await user.click(screen.getByRole('button', { name: /add prescriber/i }))
    await user.click(await screen.findByRole('button', { name: /new prescriber/i }))
    await user.click(screen.getByRole('button', { name: /save prescriber/i }))

    expect(createDoctor).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(/needs a name/i)
  })

  it('opens on Alt+O and gives Escape to nothing behind it', async () => {
    const user = userEvent.setup()
    const onEscape = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <ApiContext.Provider value={stubApi()}>
          {/* Stands in for the billing screen underneath, which steps the bill
              back a stage on Escape. Exactly one layer may close per press. */}
          <Behind onEscape={onEscape} />
          <DoctorBar doctor={null} onSelect={vi.fn()} required={false} />
        </ApiContext.Provider>
      </QueryClientProvider>,
    )

    fireEvent.keyDown(document, { key: 'o', code: 'KeyO', altKey: true })
    expect(await screen.findByRole('combobox')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument())
    expect(onEscape).not.toHaveBeenCalled()
  })
})

function Behind({ onEscape }: { onEscape: () => void }) {
  useHotkeys('billing', { escape: onEscape })
  return null
}
