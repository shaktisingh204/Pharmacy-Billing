import { Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AppShell } from '@/components/AppShell'
import { BrandProvider } from '@/brand/BrandProvider'
import { SkeletonRows } from '@/components/states'

import Dashboard from '@/pages/Dashboard'
import Billing from '@/pages/Billing'
import Medicines from '@/pages/Medicines'
import Inventory from '@/pages/Inventory'
import Purchases from '@/pages/Purchases'
import Sales from '@/pages/Sales'
import Customers from '@/pages/Customers'
import Suppliers from '@/pages/Suppliers'
import Reports from '@/pages/Reports'
import Users from '@/pages/Users'
import SettingsPage from '@/pages/SettingsPage'
import DesignGate from '@/pages/DesignGate'
import CustomerDisplay from '@/pages/CustomerDisplay'
import OwnerMobile from '@/pages/OwnerMobile'
import NotFound from '@/pages/NotFound'

/**
 * A deliberate throw, dev builds only.
 *
 * An untested error boundary is the thing that turns out to be broken on the day
 * it is needed, so this gives the suite something real to catch.
 */
function Boom(): never {
  throw new Error('Deliberate render failure')
}

export default function App() {
  return (
    <BrandProvider>
      <Suspense fallback={<SkeletonRows />}>
        <Routes>
          {/* OUTSIDE the shell, and deliberately. The customer display is dragged
              onto the second monitor and left there: a sidebar, a top bar or a
              nav rail on it is both a distraction for the customer and a way into
              the shop's data for anyone standing at the counter. */}
          <Route path="display" element={<CustomerDisplay />} />
          {/* Also outside the shell, and for the opposite reason to the display:
              the counter chrome is built for a 1366px till and a 64px icon rail
              on a 390px phone spends a sixth of the screen on navigation the
              owner will not use. This surface carries its own header. */}
          <Route path="m" element={<OwnerMobile />} />
          <Route element={<AppShell />}>
            <Route index element={<Dashboard />} />
            <Route path="billing" element={<Billing />} />
            <Route path="medicines" element={<Medicines />} />
            <Route path="inventory" element={<Inventory />} />
            <Route path="purchases" element={<Purchases />} />
            <Route path="sales" element={<Sales />} />
            <Route path="customers" element={<Customers />} />
            <Route path="suppliers" element={<Suppliers />} />
            <Route path="reports" element={<Reports />} />
            <Route path="users" element={<Users />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="_design" element={<DesignGate />} />
            {import.meta.env.DEV && <Route path="_boom" element={<Boom />} />}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
      <Toaster position="bottom-right" richColors closeButton toastOptions={{ duration: 4000 }} />
    </BrandProvider>
  )
}
