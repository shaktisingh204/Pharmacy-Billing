import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'

// Self-hosted: the till must boot on a LAN, never from a font CDN.
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@/design/tokens.css'
import '@/print/print.css'

import App from './App'
import { api } from '@/api'
import { ensureSeeded } from '@/db/seed'
import { registerServiceWorker } from '@/serviceWorker'
import { watchInstallability } from '@/brand/installable'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Stock changes constantly; nothing in this app benefits from a long stale window.
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

/* Density is persisted per user. The default is now `spacious`: `comfortable`
   was tuned for a counter grid and every non-grid screen inherited it. The dense
   modes are still applied per-route — the Medicines, Inventory and Sales grids
   run compact, and /billing runs pos — because density is the point there. */
document.documentElement.dataset['density'] =
  localStorage.getItem('rxbill.density') ?? 'spacious'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found')

// Seed and warm the in-memory search index BEFORE first paint. The billing screen
// assumes search is instant, and a cold index on the first keystroke is exactly
// the sluggishness this app exists to avoid.
const boot = ensureSeeded(new Date())
  .then(async (r) => {
    await api.init()
    if (r.seeded) {
      console.info(
        `[rxbill] seeded ${r.medicines} medicines, ${r.batches} batches, ${r.invoices} invoices`,
      )
    }
  })
  .catch((err: unknown) => {
    console.error('[rxbill] boot failed', err)
  })

await boot

/* Armed before the tree mounts, because Chrome fires `beforeinstallprompt` early
   and once only — a listener attached inside a component that mounts later has
   already missed it, which presents as an Install button that never appears. */
watchInstallability()

registerServiceWorker((activate) => {
  toast('A new version is ready', {
    description: 'It will take over when you reload. Finish the bill you are on first.',
    duration: Infinity,
    action: { label: 'Reload now', onClick: activate },
  })
})

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
