import { useState } from 'react'
import { Pill, Plus, Printer, Search } from 'lucide-react'
import { Screen } from '@/components/Screen'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Kbd } from '@/components/ui/Kbd'
import { Chip, ExpiryChip, ScheduleChip, StockChip } from '@/components/ui/Badge'
import { Code, Money, Percent, Qty } from '@/components/ui/Money'
import { EmptyState, ErrorState, OfflineState, PermissionDenied, SkeletonRows } from '@/components/states'
import type { ExpiryBucket } from '@/lib/expiry'

/**
 * THE DESIGN GATE (/_design).
 *
 * Every token, every component state and all three densities on one page,
 * reviewed and approved BEFORE any screen is built. This is what stops
 * "premium" from becoming a retrofit.
 */

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-fg">{title}</h2>
        {note ? <p className="mt-0.5 max-w-[80ch] text-sm text-fg-muted">{note}</p> : null}
      </div>
      {children}
    </section>
  )
}

function Swatch({ name, value, dark }: { name: string; value: string; dark?: boolean }) {
  return (
    <div className="w-[132px]">
      <div
        className="h-12 rounded-[var(--radius-md)] border border-border-subtle"
        style={{ background: `var(${value})` }}
      />
      <div className="mt-1 truncate text-2xs font-medium text-fg">{name}</div>
      <div className={`mono truncate text-2xs ${dark ? 'text-fg-subtle' : 'text-fg-subtle'}`}>{value}</div>
    </div>
  )
}

const ACCENT = ['--accent-1', '--accent-2', '--accent-3', '--accent-6', '--accent-9', '--accent-10', '--accent-11']
const SURFACES = ['--bg-app', '--bg-surface', '--bg-subtle', '--bg-inset', '--bg-hover']
const TEXTS = ['--fg', '--fg-muted', '--fg-subtle', '--fg-disabled']
const BORDERS = ['--border-subtle', '--border', '--border-strong']
const SEMANTIC = ['--success-9', '--warning-9', '--danger-9', '--info-9']
const STATUS = ['--status-expired', '--status-expiry-60', '--status-expiry-90', '--status-expiry-180', '--status-low-stock', '--status-out-of-stock', '--status-quarantine']
const SCHEDULES = ['--schedule-otc', '--schedule-h', '--schedule-h1', '--schedule-x', '--schedule-nrx']
const SHADOWS = ['--shadow-xs', '--shadow-sm', '--shadow-md', '--shadow-lg', '--shadow-overlay']
const RADII = ['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl']
const TYPE = [
  ['--text-4xl', 'Change due ₹240.00'],
  ['--text-3xl', 'Grand total ₹1,284.50'],
  ['--text-2xl', 'KPI value'],
  ['--text-xl', 'Page title'],
  ['--text-lg', 'Section heading'],
  ['--text-base', 'Application body text at fourteen pixels'],
  ['--text-sm', 'Dense grid body at thirteen pixels'],
  ['--text-xs', 'Chips and helper text'],
  ['--text-2xs', 'Uppercase micro-label'],
] as const
const BUCKETS: ExpiryBucket[] = ['expired', 'd30', 'd60', 'd90', 'd180', 'ok']
const DENSITIES = ['comfortable', 'compact', 'pos'] as const

export default function DesignGate() {
  const [state, setState] = useState<'skeleton' | 'empty' | 'error' | 'offline' | 'denied'>('empty')

  return (
    <Screen title="Design gate" subtitle="Every token, component state and density on one page">
      {/* ---------------- Colour ---------------- */}
      <Section title="Accent — teal" note="Committed in index.html (theme-color #0d9488). The Vite starter purple is gone.">
        <div className="flex flex-wrap gap-3">{ACCENT.map((v) => <Swatch key={v} name={v.slice(2)} value={v} />)}</div>
      </Section>

      <Section title="Surfaces, text and borders" note="Three border weights are the single biggest 'premium' tell: subtle for internal table rules, base for cards and inputs, strong for hover and pressed.">
        <div className="flex flex-wrap gap-6">
          <div className="flex flex-wrap gap-3">{SURFACES.map((v) => <Swatch key={v} name={v.slice(2)} value={v} />)}</div>
          <div className="flex flex-wrap gap-3">{TEXTS.map((v) => <Swatch key={v} name={v.slice(2)} value={v} />)}</div>
          <div className="flex flex-wrap gap-3">{BORDERS.map((v) => <Swatch key={v} name={v.slice(2)} value={v} />)}</div>
        </div>
      </Section>

      <Section title="Semantic, pharmacy status and drug schedule" note="Note --status-expiry-180 is deliberately indigo, not amber: 'still returnable to the supplier' is an opportunity, not a danger, and it must not read as red.">
        <div className="flex flex-wrap gap-6">
          <div className="flex flex-wrap gap-3">{SEMANTIC.map((v) => <Swatch key={v} name={v.slice(2)} value={v} />)}</div>
          <div className="flex flex-wrap gap-3">{STATUS.map((v) => <Swatch key={v} name={v.slice(9)} value={v} />)}</div>
          <div className="flex flex-wrap gap-3">{SCHEDULES.map((v) => <Swatch key={v} name={v.slice(11)} value={v} />)}</div>
        </div>
      </Section>

      {/* ---------------- Type ---------------- */}
      <Section title="Type scale" note="Inter Variable, self-hosted. Weights 400 / 500 / 600 — never 700; 600 at these sizes is the enterprise register.">
        <Card>
          <CardBody className="space-y-1">
            {TYPE.map(([token, sample]) => (
              <div key={token} className="flex items-baseline gap-4 border-b border-border-subtle py-1.5 last:border-0">
                <code className="mono w-24 shrink-0 text-2xs text-fg-subtle">{token.slice(2)}</code>
                <span
                  style={{ fontSize: `var(${token})`, lineHeight: `var(${token.replace('--text', '--leading')})` }}
                  className={token === '--text-2xs' ? 'micro-label' : token === '--text-3xl' || token === '--text-4xl' ? 'font-semibold' : ''}
                >
                  {sample}
                </span>
              </div>
            ))}
          </CardBody>
        </Card>
      </Section>

      <Section title="Numerics" note="The highest-leverage typographic decision in a billing app. Tabular figures stop a rupee column jittering as digits change; proportional figures also break column alignment.">
        <div className="flex gap-4">
          <Card className="flex-1">
            <CardHeader title="Tabular (.num) — shipped" />
            <CardBody className="space-y-0.5">
              {['1284.50', '99.00', '11111.11', '1234567.89', '8.33'].map((v) => (
                <div key={v}><Money value={v} className="block w-40" /></div>
              ))}
            </CardBody>
          </Card>
          <Card className="flex-1 opacity-70">
            <CardHeader title="Proportional — rejected" />
            <CardBody className="space-y-0.5">
              {['₹1,284.50', '₹99.00', '₹11,111.11', '₹12,34,567.89', '₹8.33'].map((v) => (
                <div key={v} className="w-40 text-right">{v}</div>
              ))}
            </CardBody>
          </Card>
          <Card className="flex-1">
            <CardHeader title="Mono — identifiers only" />
            <CardBody className="space-y-1">
              <div><Code value="RX2627-T1-00412" /></div>
              <div><Code value="B-2291 · 11/27" /></div>
              <div><Code value="30049099" /></div>
              <div className="flex gap-3 pt-1"><Qty value="4" /> <Percent value="5" /></div>
            </CardBody>
          </Card>
        </div>
      </Section>

      {/* ---------------- Elevation ---------------- */}
      <Section title="Radii and elevation" note="Nothing above 16px — large radii with heavy shadows read consumer, not enterprise. Cards get border + shadow-xs; elevation is reserved for things that actually float.">
        <div className="flex flex-wrap items-end gap-4">
          {RADII.map((r) => (
            <div key={r} className="text-center">
              <div className="size-16 border border-border bg-surface" style={{ borderRadius: `var(${r})` }} />
              <div className="mono mt-1 text-2xs text-fg-subtle">{r.slice(9)}</div>
            </div>
          ))}
          <div className="w-px self-stretch bg-border-subtle" />
          {SHADOWS.map((s) => (
            <div key={s} className="text-center">
              <div className="size-16 rounded-[var(--radius-lg)] bg-surface" style={{ boxShadow: `var(${s})` }} />
              <div className="mono mt-1 text-2xs text-fg-subtle">{s.slice(9)}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ---------------- Components ---------------- */}
      <Section title="Buttons" note="Tab through these. The focus ring is :focus-visible only — 2px accent at a 2px offset — and suppressing it anywhere outside base.css fails the build.">
        <Card><CardBody className="space-y-3">
          {(['primary', 'secondary', 'ghost', 'danger', 'subtle'] as const).map((variant) => (
            <div key={variant} className="flex items-center gap-3">
              <code className="mono w-20 text-2xs text-fg-subtle">{variant}</code>
              <Button variant={variant} size="sm">Small</Button>
              <Button variant={variant} size="md"><Plus />Medium</Button>
              <Button variant={variant} size="lg">Large</Button>
              <Button variant={variant} size="xl">
                Pay
                <Kbd
                  className={
                    variant === 'primary' || variant === 'danger'
                      ? 'border-transparent bg-white text-accent-11'
                      : undefined
                  }
                >
                  ⌃⏎
                </Kbd>
              </Button>
              <Button variant={variant} size="icon" aria-label="Print"><Printer /></Button>
              <Button variant={variant} disabled>Disabled</Button>
            </div>
          ))}
        </CardBody></Card>
      </Section>

      <Section title="Chips" note="Meaning is never encoded in colour alone: every chip carries an icon AND a word. POS panels are matte, dim and often viewed at an angle.">
        <Card><CardBody className="flex flex-wrap items-center gap-2">
          {BUCKETS.map((b) => <ExpiryChip key={b} bucket={b} />)}
          <span className="w-px self-stretch bg-border-subtle" />
          {(['OTC', 'H', 'H1', 'X', 'NRx'] as const).map((c) => <ScheduleChip key={c} code={c} />)}
          <span className="w-px self-stretch bg-border-subtle" />
          <StockChip qty={0} reorderLevel={10} />
          <StockChip qty={6} reorderLevel={10} />
          <StockChip qty={120} reorderLevel={10} />
          <Chip tone="var(--status-quarantine)">Quarantined</Chip>
        </CardBody></Card>
      </Section>

      {/* ---------------- States ---------------- */}
      <Section title="The five mandatory states" note="Every data surface renders all five, asserted by a Playwright sweep. Loading is skeleton rows at the real row height — never a centred spinner.">
        <div className="mb-2 flex gap-2">
          {(['skeleton', 'empty', 'error', 'offline', 'denied'] as const).map((s) => (
            <Button key={s} size="sm" variant={state === s ? 'primary' : 'secondary'} onClick={() => setState(s)}>{s}</Button>
          ))}
        </div>
        <Card className="overflow-hidden">
          {state === 'skeleton' && <SkeletonRows rows={6} cols={5} />}
          {state === 'empty' && (
            <EmptyState icon={Pill} title="No medicines yet" body="Add your first medicine, or receive a supplier bill to create stock." actionLabel="Add medicine" shortcut="Alt+C" />
          )}
          {state === 'error' && <ErrorState code="STOCK_INSUFFICIENT" message="Only 3 units of batch B-2291 remain." onRetry={() => {}} />}
          {state === 'offline' && <OfflineState queued={3} />}
          {state === 'denied' && <PermissionDenied needs="reports.margin" />}
        </Card>
      </Section>

      {/* ---------------- Density ---------------- */}
      <Section title="Density" note="Swapped by data-density on <html>, persisted per user. Note POS is LARGER, not smaller: a counter operator on a matte touch panel needs bigger targets even though the screen carries more information.">
        <div className="flex gap-4">
          {DENSITIES.map((d) => (
            <Card key={d} className="flex-1 overflow-hidden" data-density={d}>
              <CardHeader title={<span className="capitalize">{d}</span>} action={<Chip>row {d === 'compact' ? '36' : '44'}px</Chip>} />
              <div>
                {[['Dolo 650', 'B-2291', '11/27', '4', '30.60'], ['Azithral 500', 'AZ-88', '03/27', '1', '118.00'], ['Pan-D', 'PD-140', '08/26', '2', '212.40']].map((r) => (
                  <div key={r[0]} className="flex items-center gap-2 border-b border-border-subtle last:border-0" style={{ height: 'var(--row-h)', paddingInline: 'var(--cell-px)', fontSize: 'var(--font-body)' }}>
                    <span className="min-w-0 flex-1 truncate">{r[0]}</span>
                    <Code value={r[1] ?? ''} className="text-2xs" />
                    <Code value={r[2] ?? ''} className="text-2xs" />
                    <Qty value={r[3] ?? '0'} className="w-6" />
                    <Money value={r[4] ?? '0'} symbol={false} className="w-16" />
                  </div>
                ))}
              </div>
              <CardBody className="flex gap-2 border-t border-border-subtle">
                <Button size="sm">Action</Button>
                <Button size="md" variant="primary">Primary</Button>
              </CardBody>
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Inputs and focus" note="The search field is the most-used control in the app. Tab here and confirm the ring reads clearly at arm's length on a matte panel.">
        <Card><CardBody className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <input
              placeholder="Scan barcode or type a medicine…"
              aria-label="Medicine search"
              className="h-11 w-[380px] rounded-[var(--radius-md)] border border-border bg-surface pl-9 pr-3 text-lg placeholder:text-fg-subtle hover:border-border-strong"
            />
          </div>
          <input aria-label="Quantity" defaultValue="4" data-focus-inset className="num h-[var(--control-h)] w-20 rounded-[var(--radius-sm)] border border-border bg-surface px-2" />
          <span className="flex items-center gap-1 text-sm text-fg-muted">Press <Kbd>/</Kbd> to focus search</span>
        </CardBody></Card>
      </Section>
    </Screen>
  )
}
