import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiAdapter, Customer, SaleInvoice } from '@contract'
import { ApiError } from '@contract'
import { ApiContext } from '@/api'
import { CustomerPanel } from './CustomerPanel'

/**
 * The four behaviours that are expensive to get wrong at a counter:
 * a half-typed phone reaching the master, an allergy that cannot be entered,
 * a duplicate presented as a failure, and an allergy strip that does not show.
 */

const RAMESH: Customer = {
  id: 7,
  storeId: 1,
  name: 'Ramesh Kulkarni',
  phone: '9876543210',
  address: null,
  gstin: null,
  allergies: ['Penicillin'],
  creditLimit: '5000.00',
  outstanding: '1200.00',
}

/** Only the four customer calls the panel makes; the rest must never be reached. */
function stubApi(over: Partial<ApiAdapter> = {}): ApiAdapter {
  const base = {
    searchCustomers: async (): Promise<Customer[]> => [],
    recentCustomers: async (): Promise<Customer[]> => [],
    customerHistory: async (): Promise<SaleInvoice[]> => [],
    createCustomer: async (): Promise<Customer> => {
      throw new Error('createCustomer was not stubbed for this test')
    },
    ...over,
  }
  return base as unknown as ApiAdapter
}

function renderPanel(
  props: Partial<Parameters<typeof CustomerPanel>[0]> = {},
  api: ApiAdapter = stubApi(),
) {
  const onAttach = vi.fn()
  const onClear = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <ApiContext.Provider value={api}>
        <CustomerPanel customer={null} onAttach={onAttach} onClear={onClear} {...props} />
      </ApiContext.Provider>
    </QueryClientProvider>,
  )
  return { onAttach, onClear }
}

/** Search for a term that matches nothing, then take the create affordance. */
async function openCreateForm(user: ReturnType<typeof userEvent.setup>, term: string) {
  await user.type(screen.getByLabelText('Find customer'), term)
  await user.click(await screen.findByRole('button', { name: `Create ${term}` }))
}

describe('creating a customer', () => {
  it('refuses a 9-digit phone with a message on the field', async () => {
    const user = userEvent.setup()
    const createCustomer = vi.fn()
    renderPanel({}, stubApi({ createCustomer }))

    await openCreateForm(user, '987654321')
    await user.type(screen.getByLabelText(/^Name/), 'Asha Rane')
    await user.click(screen.getByRole('button', { name: /Save & attach/ }))

    expect(await screen.findByText(/a phone number needs 10/)).toBeInTheDocument()
    // Focus lands on the offending field, so the fix is one keystroke away.
    expect(screen.getByLabelText(/^Phone/)).toHaveFocus()
    expect(createCustomer).not.toHaveBeenCalled()
  })

  it('adds an allergy on Enter and drops the last one on Backspace', async () => {
    const user = userEvent.setup()
    renderPanel()

    await openCreateForm(user, '9876543210')
    const allergies = screen.getByLabelText(/^Allergies/)

    await user.type(allergies, 'Penicillin{Enter}')
    expect(screen.getByRole('button', { name: 'Remove Penicillin' })).toBeInTheDocument()

    // The field is empty again, so Backspace means "undo the last chip".
    await user.type(allergies, '{Backspace}')
    expect(screen.queryByRole('button', { name: 'Remove Penicillin' })).not.toBeInTheDocument()
  })

  it('offers to attach the existing customer instead of showing a duplicate error', async () => {
    const user = userEvent.setup()
    const createCustomer = vi.fn().mockRejectedValue(
      new ApiError({
        code: 'CUSTOMER_EXISTS',
        message: 'Ramesh Kulkarni is already registered on 9876543210',
        details: RAMESH,
      }),
    )
    const { onAttach } = renderPanel({}, stubApi({ createCustomer }))

    await openCreateForm(user, '9876543210')
    await user.type(screen.getByLabelText(/^Name/), 'Asha Rane')
    await user.click(screen.getByRole('button', { name: /Save & attach/ }))

    const attach = await screen.findByRole('button', { name: 'Attach Ramesh Kulkarni instead' })
    expect(screen.queryByText(/already registered on/)).not.toBeInTheDocument()

    await user.click(attach)
    expect(onAttach).toHaveBeenCalledWith(RAMESH)
  })
})

describe('an attached customer', () => {
  it('spells out the allergens rather than counting them', async () => {
    renderPanel({ customer: { ...RAMESH, allergies: ['Penicillin', 'Sulpha drugs'] } })

    const strip = await screen.findByTestId('allergy-strip')
    expect(strip).toHaveTextContent('Penicillin, Sulpha drugs')
  })
})
