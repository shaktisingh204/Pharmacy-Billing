import { Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AppShell } from '@/components/AppShell'
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
import NotFound from '@/pages/NotFound'

export default function App() {
  return (
    <>
      <Suspense fallback={<SkeletonRows />}>
        <Routes>
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
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
      <Toaster position="bottom-right" richColors closeButton toastOptions={{ duration: 4000 }} />
    </>
  )
}
