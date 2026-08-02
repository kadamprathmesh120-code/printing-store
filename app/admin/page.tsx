'use client'

import { useEffect, useState } from 'react'
import { AdminLogin } from '@/components/admin/admin-login'
import { AdminDashboard } from '@/components/admin/admin-dashboard'

export default function AdminPage() {
  const [checking, setChecking] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)

  useEffect(() => {
    fetch('/api/admin/login')
      .then((res) => res.json())
      .then((data) => setAuthenticated(Boolean(data.authenticated)))
      .catch(() => setAuthenticated(false))
      .finally(() => setChecking(false))
  }, [])

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col px-4 pb-10">
      <header className="flex flex-col items-center gap-1 py-6 text-center">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-lg font-bold text-secondary-foreground">
            P
          </span>
          <h1 className="text-2xl font-bold tracking-tight">Shop Counter</h1>
        </div>
        <p className="text-sm text-muted-foreground text-balance">
          Review payments and accept or reject print orders.
        </p>
      </header>

      {checking ? (
        <div className="flex justify-center py-10">
          <div
            className="h-10 w-10 animate-spin rounded-full border-4 border-muted border-t-primary"
            aria-hidden="true"
          />
        </div>
      ) : authenticated ? (
        <AdminDashboard />
      ) : (
        <AdminLogin onSuccess={() => setAuthenticated(true)} />
      )}
    </main>
  )
}
