import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, PackageX, Plus } from 'lucide-react'
import type { MedicineSearchHit } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { Kbd } from '@/components/ui/Kbd'
import { ScheduleChip, StockChip } from '@/components/ui/Badge'

/**
 * The most-used control in the application.
 *
 * Two rules drive the whole design:
 *  - Focus is never stolen. Results landing must not disturb a half-typed word,
 *    so the highlighted option moves via aria-activedescendant while DOM focus
 *    stays in the input (the W3C editable-combobox pattern).
 *  - Out-of-stock hits appear BELOW an explicit divider and never above something
 *    dispensable. They are still shown, because a refused sale is the highest-signal
 *    demand event in the shop and it feeds the short book.
 */
export function SearchPane({
  onPick,
  onShortbook,
  inputRef,
}: {
  onPick: (hit: MedicineSearchHit) => void
  onShortbook: (term: string, hit: MedicineSearchHit | null) => void
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  const api = useApi()
  const [term, setTerm] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const { data: hits = [] } = useQuery({
    queryKey: ['search', term],
    queryFn: () => api.searchMedicines({ term, limit: 8 }),
    enabled: term.trim().length > 0,
    placeholderData: (prev) => prev,
  })

  const { inStock, outOfStock } = useMemo(() => ({
    inStock: hits.filter((h) => !h.outOfStock),
    outOfStock: hits.filter((h) => h.outOfStock),
  }), [hits])
  const ordered = useMemo(() => [...inStock, ...outOfStock], [inStock, outOfStock])

  useEffect(() => { setActive(0) }, [term])

  function commit(hit: MedicineSearchHit | undefined) {
    if (!hit) return
    if (hit.outOfStock) { onShortbook(term, hit); return }
    onPick(hit)
    setTerm('')
    setActive(0)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // A MODIFIED Enter is never "add the highlighted item": Ctrl+Enter goes to
    // payment and Ctrl+S saves. Swallowing them here would make those shortcuts
    // dead everywhere that matters, because search is where focus rests between
    // every action.
    if (e.ctrlKey || e.metaKey || e.altKey) return

    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, ordered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); commit(ordered[active]) }
    else if (e.key === 'Escape') {
      if (term) { e.stopPropagation(); setTerm('') }
    }
  }

  return (
    <div className="flex h-full min-h-0 w-[320px] shrink-0 flex-col border-r border-border bg-surface 2xl:w-[380px]">
      <div className="p-3">
        <div className="relative">
          <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <input
            ref={inputRef}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={ordered.length > 0}
            aria-controls="search-results"
            aria-autocomplete="list"
            aria-activedescendant={ordered[active] ? `hit-${ordered[active].medicine.id}` : undefined}
            placeholder="Scan barcode or type a medicine…"
            aria-label="Medicine search"
            autoComplete="off"
            spellCheck={false}
            className={cn(
              'h-11 w-full rounded-[var(--radius-md)] border border-border bg-surface pl-10 pr-16',
              'text-lg placeholder:text-fg-subtle hover:border-border-strong',
            )}
          />
          <Kbd className="absolute right-3 top-1/2 -translate-y-1/2">/</Kbd>
        </div>
      </div>

      <div ref={listRef} id="search-results" role="listbox" aria-label="Search results" className="scroll-region min-h-0 flex-1">
        {term.trim() === '' ? (
          <Hint />
        ) : ordered.length === 0 ? (
          <NoResults term={term} onShortbook={() => onShortbook(term, null)} />
        ) : (
          <>
            {inStock.map((hit, i) => (
              <Row key={hit.medicine.id} hit={hit} active={i === active} onPick={() => commit(hit)} onHover={() => setActive(i)} />
            ))}
            {outOfStock.length > 0 && (
              <div className="sticky top-0 flex items-center gap-2 border-y border-border-subtle bg-subtle px-3 py-1">
                <PackageX size={12} className="text-fg-subtle" aria-hidden />
                <span className="micro-label">Not in stock</span>
              </div>
            )}
            {outOfStock.map((hit, i) => (
              <Row
                key={hit.medicine.id}
                hit={hit}
                active={inStock.length + i === active}
                onPick={() => commit(hit)}
                onHover={() => setActive(inStock.length + i)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function Row({ hit, active, onPick, onHover }: { hit: MedicineSearchHit; active: boolean; onPick: () => void; onHover: () => void }) {
  const m = hit.medicine
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: 'nearest' }) }, [active])

  return (
    <div
      ref={ref}
      id={`hit-${m.id}`}
      role="option"
      aria-selected={active}
      onMouseDown={(e) => { e.preventDefault(); onPick() }}
      onMouseEnter={onHover}
      className={cn(
        'relative flex h-14 cursor-pointer flex-col justify-center gap-0.5 px-3',
        'border-b border-border-subtle',
        active ? 'bg-accent-3' : 'hover:bg-hover',
        hit.outOfStock && 'opacity-70',
      )}
    >
      {active && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" />}
      <div className="flex items-baseline gap-2">
        <span className={cn('truncate text-base font-medium', active && 'text-accent-11')}>{m.brandName}</span>
        <span className="shrink-0 text-xs text-fg-muted">{m.strengthText}</span>
        <span className="shrink-0 text-xs text-fg-subtle">{m.packLabel}</span>
        <span className="ml-auto shrink-0 num text-base font-medium">
          {hit.fefoBatch ? formatMoney(hit.fefoBatch.mrpPerPack) : '—'}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        <span className="truncate">{m.compositionText}</span>
        <span className="shrink-0 text-fg-subtle">·</span>
        <span className="shrink-0 truncate text-fg-subtle">{m.manufacturer}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <ScheduleChip code={m.drugSchedule} />
          <StockChip qty={Number(hit.stockQty)} reorderLevel={m.reorderLevel} />
        </span>
      </div>
    </div>
  )
}

function Hint() {
  return (
    <div className="px-4 py-8 text-center text-sm text-fg-muted">
      <p>Scan a strip, or type a brand, salt or manufacturer.</p>
      <p className="mt-3 flex flex-wrap items-center justify-center gap-1.5 text-xs">
        <Kbd>↑</Kbd><Kbd>↓</Kbd> to move · <Kbd>↵</Kbd> to add · <Kbd>F7</Kbd> for substitutes
      </p>
    </div>
  )
}

function NoResults({ term, onShortbook }: { term: string; onShortbook: () => void }) {
  return (
    <div className="px-4 py-8 text-center">
      <PackageX size={32} strokeWidth={1.5} className="mx-auto text-fg-subtle" aria-hidden />
      <p className="mt-2 text-base font-medium text-fg">Nothing matches “{term}”</p>
      <p className="mt-1 text-sm text-fg-muted">
        A refused sale is worth recording — it is what tells you to stock it.
      </p>
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); onShortbook() }}
        className="mt-3 inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-border bg-surface px-3 py-1.5 text-sm hover:border-border-strong hover:bg-hover"
      >
        <Plus size={14} aria-hidden /> Add to short book <Kbd>S</Kbd>
      </button>
    </div>
  )
}
