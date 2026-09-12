import { useCallback, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  FileSpreadsheet, NotebookPen, PackageSearch, PanelRightClose, PanelRightOpen, PackageX,
  ScrollText, TrendingUp, Truck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { GrnEntry } from './GrnEntry'
import type { GrnSeed } from './GrnEntry'
import { PurchaseRegister } from './PurchaseRegister'
import { ShortbookPanel } from './ShortbookPanel'
import { SupplierReturns } from './SupplierReturns'
import { ImportWizard } from './ImportWizard'
import { ReorderPanel } from './ReorderPanel'
import { PurchaseInsights } from './PurchaseInsights'

/**
 * Purchases: goods receipt on one side, the register on the other.
 *
 * The whole view is in the URL — which side is showing, which document is open,
 * whether the short book is up — so a view is a link. "Check bill INV-4471" is a
 * paste, the back button walks the tabs the operator actually used, and a reload
 * lands on the same document.
 *
 * The two tabs are one screen rather than two routes on purpose. Receiving goods
 * and checking whether that bill is already in the book are the same task
 * interrupted: the duplicate banner on the receipt hands a document id straight
 * to the register, and a route change would throw away the half-keyed bill that
 * caused the question.
 *
 * Which is why the receipt is HIDDEN on the register tab rather than unmounted.
 * Unmounting would throw the draft away just as thoroughly as a route change and
 * would make the duplicate banner a trap: it sends the operator to the register
 * to look at the bill they have half-keyed, and the half-keyed bill has to still
 * be there when they come back. The register is mounted only when it is showing,
 * because its virtualiser measures a scroll element that a hidden pane does not
 * have.
 *
 * DENSITY IS PER REGION, NOT PER PAGE. The screen runs at the app's spacious
 * default — a page header, a tab bar and a set of cards read as designed at that
 * size — and each dense grid inside it declares `compact` for itself. The whole
 * screen used to be compact, which bought the goods-receipt grid four rows and
 * cost every other tab its hierarchy.
 */

type Tab = 'grn' | 'register' | 'returns' | 'import' | 'order' | 'insights'

const TABS: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: 'grn', label: 'Goods receipt', icon: Truck },
  { id: 'register', label: 'Register', icon: ScrollText },
  { id: 'returns', label: 'Returns', icon: PackageX },
  { id: 'order', label: 'Order', icon: PackageSearch },
  { id: 'import', label: 'Import', icon: FileSpreadsheet },
  { id: 'insights', label: 'Insights', icon: TrendingUp },
]

/** One line under the title. It says what this tab is FOR, not what it contains. */
const DESCRIPTION: Record<Tab, string> = {
  grn: 'Goods receipt against a supplier bill — batch, expiry, MRP and the rate that becomes your landed cost.',
  register: 'Every bill this shop has received, what it cost and what is still owed on it.',
  returns: 'Stock going back — a debit note against a bill, or an expiry claim on its own invoice.',
  order: 'What to order, with the working on every row — and anything already on an open order taken off the number.',
  import: 'Read a distributor bill straight in — the column mapping and every product name are remembered per supplier.',
  insights: 'What the purchase book says about your distributors: where the money goes, who delivers, and whose rates are moving.',
}

/** Local calendar day. `toISOString` is UTC and would roll the date over at
 *  05:30 in India — the wrong day on every document raised after half five. */
function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function readTab(raw: string | null): Tab {
  const hit = TABS.find((t) => t.id === raw)
  return hit ? hit.id : 'grn'
}

export function PurchasesScreen() {
  const [params, setParams] = useSearchParams()

  const tab = readTab(params.get('tab'))
  const today = localIsoDate(new Date())
  const docParam = params.get('doc')
  const selectedId = docParam !== null && /^\d+$/.test(docParam) ? Number(docParam) : null
  /* Present-and-'0' hides it. Absent means the default, which is open: the short
     book is only worth anything at the moment a supplier bill is being keyed. */
  const shortbookOpen = params.get('sb') !== '0'

  /* A pick from the short book is handed to the receipt as a numbered request,
     so the same medicine can be sent twice — a distributor bill legitimately
     carries the same brand at two MRPs on two lines. */
  const [seed, setSeed] = useState<GrnSeed | null>(null)
  const nonce = useRef(0)

  const setTab = useCallback((next: Tab, doc: number | null) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next === 'grn') p.delete('tab')
      else p.set('tab', next)
      if (doc === null) p.delete('doc')
      else p.set('doc', String(doc))
      /* The returns tab's handoff is per-visit. Leaving it in the URL would put
         the operator back on somebody else's debit note two tabs later. */
      p.delete('against')
      p.delete('supplier')
      return p
    })
  }, [setParams])

  /**
   * "Raise a debit note against this bill", from the register.
   *
   * The document and its supplier travel in the URL rather than in state, for
   * the same reason everything else on this screen does: the operator is about
   * to be interrupted, and a half-built return has to survive a reload.
   */
  const returnAgainst = useCallback((purchaseId: number, supplierId: number) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      p.set('tab', 'returns')
      p.set('against', String(purchaseId))
      p.set('supplier', String(supplierId))
      p.delete('doc')
      return p
    })
  }, [setParams])

  /* Opening a document REPLACES rather than pushes: arrowing down the register
     must not leave forty stops in the history. Esc closes the panel, Back leaves
     the register. */
  const selectDoc = useCallback((id: number | null) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      if (id === null) p.delete('doc')
      else p.set('doc', String(id))
      return p
    }, { replace: true })
  }, [setParams])

  const toggleShortbook = useCallback(() => {
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      if (p.get('sb') === '0') p.delete('sb')
      else p.set('sb', '0')
      return p
    }, { replace: true })
  }, [setParams])

  const numeric = (key: string): number | null => {
    const raw = params.get(key)
    return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null
  }

  return (
    <div className="flex h-full flex-col">
      <header className="page-header shrink-0 px-[var(--page-px)] py-3">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          {/* `flex-1` with a truncating description, so the tab bar stays on the
              title's line at the 1366 floor. A header that wraps to two rows
              costs the goods-receipt grid a row and a half of the bill. */}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-fg">Purchases</h1>
            <p className="mt-0.5 truncate text-sm text-fg-muted" title={DESCRIPTION[tab]}>
              {DESCRIPTION[tab]}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {tab === 'grn' ? (
              <Button onClick={toggleShortbook} aria-pressed={shortbookOpen}>
                {shortbookOpen ? <PanelRightClose /> : <PanelRightOpen />}
                <NotebookPen /> Short book
              </Button>
            ) : null}
            <div
              role="tablist"
              aria-label="Purchases view"
              className="flex h-11 items-center gap-0.5 rounded-[var(--radius-lg)] border border-border-subtle bg-inset p-1"
            >
              {TABS.map((t) => (
                <TabButton
                  key={t.id}
                  active={tab === t.id}
                  icon={t.icon}
                  label={t.label}
                  /* Only the register carries a document; every other tab drops
                     it, so switching away and back does not reopen a bill the
                     operator has finished with. */
                  onClick={() => setTab(t.id, t.id === 'register' ? selectedId : null)}
                />
              ))}
            </div>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-[var(--card-gap)] px-[var(--page-px)] pt-[var(--card-gap)] pb-[var(--card-gap)]">
        {/* `flex` and `hidden` both set `display`, and which one wins is decided
            by Tailwind's own source order rather than by the order they are
            written in — so the two are never in the class list together. */}
        {/* `inert` while hidden, not merely `display:none`.
            The receipt stays MOUNTED on the other tabs so a half-keyed bill
            survives a trip to the register — but a mounted pane is still in the
            tab order and still in the accessibility tree. On the Returns tab
            that meant Tab walked out of the visible form and into an invisible
            goods receipt, and a screen reader announced two "Supplier" fields
            with only one of them on screen. `inert` removes it from both while
            keeping the draft exactly where it was. */}
        <div
          inert={tab !== 'grn'}
          className={tab === 'grn' ? 'flex min-h-0 flex-1 gap-[var(--card-gap)]' : 'hidden'}
        >
          <div className="card flex min-w-0 flex-1 flex-col overflow-hidden">
            <GrnEntry
              seed={seed}
              onOpenPurchase={(id) => setTab('register', id)}
            />
          </div>
          {shortbookOpen ? (
            <ShortbookPanel
              onAddToGrn={(next) => {
                nonce.current += 1
                setSeed({ ...next, nonce: nonce.current })
              }}
            />
          ) : null}
        </div>

        {tab === 'register' ? (
          <PurchaseRegister
            selectedId={selectedId}
            onSelect={selectDoc}
            onNewGrn={() => setTab('grn', null)}
            onReturnAgainst={returnAgainst}
          />
        ) : null}

        {/* Mounted only while showing, like the register and for the same
            reason: its stock table and the claims list both measure a scroll
            element a hidden pane does not have. Nothing is lost by unmounting —
            unlike the half-keyed goods receipt, a return draft is three fields
            and the tab is not somewhere the duplicate banner sends anyone. */}
        {tab === 'returns' ? (
          <SupplierReturns
            today={today}
            initialSupplierId={numeric('supplier')}
            initialAgainstPurchaseId={numeric('against')}
          />
        ) : null}

        {tab === 'order' ? <ReorderPanel /> : null}

        {tab === 'import' ? (
          <ImportWizard onPosted={(id) => setTab('register', id)} />
        ) : null}

        {tab === 'insights' ? (
          <PurchaseInsights onOpenPurchase={(id) => setTab('register', id)} />
        ) : null}
      </div>
    </div>
  )
}

function TabButton({
  active, icon: Icon, label, onClick,
}: {
  active: boolean
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-full items-center gap-1.5 rounded-[var(--radius-md)] px-3 text-sm font-medium',
        'transition-[background-color,color,box-shadow] duration-[var(--dur-fast)]',
        active
          ? 'bg-surface text-fg shadow-[var(--shadow-xs)]'
          : 'text-fg-muted hover:bg-surface/60 hover:text-fg',
      )}
    >
      <Icon size={15} aria-hidden />
      {label}
    </button>
  )
}
