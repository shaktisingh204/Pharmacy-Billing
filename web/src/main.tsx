import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Self-hosted: the till must boot on a LAN, never from a font CDN.
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@/design/tokens.css'
import '@/print/print.css'

import App from './App'
import { api } from '@/api'
import { ensureSeeded } from '@/db/seed'

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

// Density is persisted per user; POS is applied per-route in Phase 2.
document.documentElement.dataset['density'] =
  localStorage.getItem('rxbill.density') ?? 'comfortable'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found')

// Seed and warm the in-memory search index BEFORE first paint. The billing screen
// assumes search is instant, and a cold index on the first keystroke is exactly
// the sluggishness this app exists to avoid.
const boot = ensureSeeded(new Date())
  .then(async (r) => {
    await api.init()
    if (r.seeded) console.info(`[rxbill] seeded ${r.medicines} medicines, ${r.batches} batches`)
  })
  .catch((err: unknown) => {
    console.error('[rxbill] boot failed', err)
  })

await boot

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
