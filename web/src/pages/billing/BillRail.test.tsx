import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Quote, QuoteLine, TaxBreakupRow } from '@contract'
import { BillRail } from './BillRail'

/**
 * The rail is the surface the money is read off, so these cover the four things
 * that are wrong at a counter rather than merely ugly: a total shown for a bill
 * nobody priced, a missing round-off line, a breakup that pushes the total off a
 * 768px screen, and a discount the operator can fat-finger past 100%.
 */

const LINE: QuoteLine = {
  lineId: 'l1', medicineId: 1, brandName: 'Dolo 650', packLabel: '1x15', hsnCode: '30049099',
  drugSchedule: 'H', requestedQty: '10', allocatedQty: '10', shortQty: '0', allocations: [],
  discountPct: '0', grossAmount: '250.00', discountAmount: '0.00', taxableValue: '238.10',
  cgst: '5.95', sgst: '5.95', igst: '0.00', lineTotal: '250.00', manualBatch: false,
}

function rate(gstRatePct: string): TaxBreakupRow {
  return {
    gstRatePct, taxableValue: '100.00', cgst: '2.50', sgst: '2.50', igst: '0.00', total: '105.00',
  }
}

function quoteOf(patch: Partial<Quote> = {}): Quote {
  return {
    lines: [LINE], grossAmount: '250.00', itemDiscount: '0.00', billDiscountPct: '0',
    billDiscount: '0.00', taxableValue: '238.10', cgst: '5.95', sgst: '5.95', igst: '0.00',
    roundOff: '0.00', netAmount: '250.00', taxBreakup: [], warnings: [], costOfGoods: '180.00',
    ...patch,
  }
}

function railWith(props: Partial<Parameters<typeof BillRail>[0]> = {}) {
  return (
    <BillRail
      quote={quoteOf()}
      quoteError={null}
      itemCount={1}
      hasH1={false}
      prescriptionDone={false}
      onPrescription={() => {}}
      billDiscountPct="0"
      onBillDiscount={() => {}}
      billNote=""
      onBillNote={() => {}}
      onPay={() => {}}
      {...props}
    />
  )
}

function renderRail(props: Partial<Parameters<typeof BillRail>[0]> = {}) {
  return render(railWith(props))
}

describe('BillRail', () => {
  it('refuses to show a total it did not compute', () => {
    const onPay = vi.fn()
    renderRail({ quoteError: new Error('No GST rate for HSN 30049099 on 2026-09-08'), onPay })

    expect(screen.getByTestId('total-net')).toHaveTextContent('Unpriced')
    expect(screen.getByTestId('total-net')).not.toHaveTextContent('250')
    expect(screen.getByTestId('quote-error')).toHaveTextContent('No GST rate for HSN 30049099')

    const pay = screen.getByRole('button', { name: /pay/i })
    expect(pay).toBeDisabled()
    fireEvent.click(pay)
    expect(onPay).not.toHaveBeenCalled()
  })

  it('shows round off even at zero — an unexplained rupee is the dispute', () => {
    renderRail({ quote: quoteOf({ roundOff: '0.00' }) })

    expect(screen.getByTestId('total-roundoff')).toHaveTextContent('Round off')
    expect(screen.getByTestId('total-roundoff')).toHaveTextContent('0.00')
  })

  it('keeps a three-rate breakup expanded', () => {
    renderRail({ quote: quoteOf({ taxBreakup: [rate('0'), rate('5'), rate('12')] }) })

    expect(screen.getAllByTestId('gst-row')).toHaveLength(3)
    expect(screen.getByRole('button', { name: /GST breakup \(3 rates\)/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('collapses a five-rate breakup so it cannot push the total off screen', () => {
    renderRail({ quote: quoteOf({ taxBreakup: [rate('0'), rate('5'), rate('12'), rate('18'), rate('28')] }) })

    expect(screen.queryAllByTestId('gst-row')).toHaveLength(0)
    const summary = screen.getByRole('button', { name: /GST breakup \(5 rates\)/ })
    expect(summary).toHaveAttribute('aria-expanded', 'false')

    // Collapsed is a default, not a lock: the filing detail is one keystroke away.
    fireEvent.click(summary)
    expect(screen.getAllByTestId('gst-row')).toHaveLength(5)
  })

  it('clamps the bill discount to 100 and never hands up a number', () => {
    const onBillDiscount = vi.fn()
    renderRail({ onBillDiscount })

    const input = screen.getByLabelText('Bill discount')
    fireEvent.change(input, { target: { value: '150' } })
    expect(onBillDiscount).toHaveBeenLastCalledWith('100')

    // A decimal percentage is legitimate and must survive untouched, as a string.
    fireEvent.change(input, { target: { value: '7.5' } })
    expect(onBillDiscount).toHaveBeenLastCalledWith('7.5')
  })

  /**
   * Nobody pastes a discount; they type it, and '7.' and '.5' are what the field
   * holds on the way. D.dec throws on both, and a throw out of onChange does not
   * reject the keystroke — it unmounts the screen mid-bill.
   */
  it('survives a decimal typed one keystroke at a time', () => {
    const onBillDiscount = vi.fn()
    const { rerender } = renderRail({ onBillDiscount })
    const input = screen.getByLabelText('Bill discount')

    for (const [typed, quoted] of [['7', '7'], ['7.', '7'], ['7.5', '7.5']] as const) {
      fireEvent.change(input, { target: { value: typed } })
      expect(onBillDiscount).toHaveBeenLastCalledWith(quoted)
      // The parent stores the priced value; the half-typed one has to stay on screen.
      rerender(railWith({ onBillDiscount, billDiscountPct: quoted }))
      expect(input).toHaveValue(typed)
    }
  })

  it('takes a bare .5 and a cleared field without throwing', () => {
    const onBillDiscount = vi.fn()
    renderRail({ onBillDiscount })
    const input = screen.getByLabelText('Bill discount')

    fireEvent.change(input, { target: { value: '.5' } })
    expect(onBillDiscount).toHaveBeenLastCalledWith('0.5')

    // Clearing to retype is not 'zero percent' on screen, but it must still quote.
    fireEvent.change(input, { target: { value: '' } })
    expect(onBillDiscount).toHaveBeenLastCalledWith('0')
  })
})
