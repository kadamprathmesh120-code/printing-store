'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

interface AdminLoginProps {
  onSuccess: () => void
}

export function AdminLogin({ onSuccess }: AdminLoginProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Login failed.')
        return
      }
      onSuccess()
    } catch {
      setError('Could not log in. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-xl border-2 border-secondary bg-card p-6">
      <h2 className="text-xl font-bold">Shop Owner Login</h2>
      <div className="flex flex-col gap-2">
        <label htmlFor="admin-password" className="text-sm font-semibold">
          Password
        </label>
        <input
          id="admin-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter admin password"
          className="h-12 rounded-lg border-2 border-border bg-card px-4 text-base focus:outline-none focus:ring-2 focus:ring-ring"
          autoFocus
        />
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={submitting || !password} size="lg" className="h-12 font-bold">
        {submitting ? 'Logging in...' : 'Log In'}
      </Button>
      <p className="text-sm text-muted-foreground">
        Default password is <span className="font-mono font-semibold">print123</span>. Set the{' '}
        <span className="font-mono font-semibold">ADMIN_PASSWORD</span> environment variable to change it.
      </p>
    </form>
  )
}
