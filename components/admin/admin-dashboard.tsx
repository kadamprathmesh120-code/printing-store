'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import type { OrderPublic } from '@/lib/store'

const fetcher = (url: string) => fetch(url).then((res) => res.json())

const STATUS_LABEL: Record<OrderPublic['status'], string> = {
  pending_payment: 'Awaiting payment',
  paid: 'PAID - Needs decision',
  accepted: 'Accepted',
  rejected: 'Rejected',
}

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hr ago`
  return `${Math.floor(hours / 24)} d ago`
}

function printFiles(order: OrderPublic) {
  order.files.forEach((_, i) => {
    const win = window.open(`/api/files/${order.id}/${i}`, '_blank')
    if (win) {
      win.addEventListener('load', () => {
        setTimeout(() => win.print(), 500)
      })
    }
  })
}

export function AdminDashboard() {
  const { data, mutate } = useSWR<{ orders: OrderPublic[] }>('/api/admin/orders', fetcher, {
    refreshInterval: 3000,
  })
  const [busy, setBusy] = useState<string | null>(null)

  const orders = data?.orders ?? []
  const paidOrders = orders.filter((o) => o.status === 'paid')
  const otherOrders = orders.filter((o) => o.status !== 'paid')

  async function decide(order: OrderPublic, action: 'accept' | 'reject') {
    setBusy(order.id)
    try {
      const res = await fetch(`/api/admin/orders/${order.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (res.ok) {
        mutate()
        if (action === 'accept') {
          printFiles(order)
        }
      }
    } finally {
      setBusy(null)
    }
  }

  function renderOrder(order: OrderPublic, showActions: boolean) {
    return (
      <li
        key={order.id}
        className={`flex flex-col gap-3 rounded-xl border-2 bg-card p-4 ${
          order.status === 'paid' ? 'border-primary' : 'border-border'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">{order.customerName}</p>
            <p className="text-sm text-muted-foreground">
              {`${timeAgo(order.createdAt)} · ${order.totalPages} pages × ${order.copies} ${order.copies > 1 ? 'copies' : 'copy'}`}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xl font-bold text-primary">{`₹${order.price}`}</p>
            <p className="text-xs font-semibold uppercase text-muted-foreground">
              {order.printType === 'bw' ? 'B&W' : 'Colour'}
            </p>
          </div>
        </div>

        <span
          className={`self-start rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${
            order.status === 'paid'
              ? 'bg-primary text-primary-foreground'
              : order.status === 'accepted'
                ? 'bg-success text-success-foreground'
                : order.status === 'rejected'
                  ? 'bg-destructive text-destructive-foreground'
                  : 'bg-muted text-muted-foreground'
          }`}
        >
          {STATUS_LABEL[order.status]}
        </span>

        <ul className="flex flex-col gap-1">
          {order.files.map((file, i) => (
            <li key={i} className="flex items-center justify-between gap-2 text-sm">
              <a
                href={`/api/files/${order.id}/${i}`}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 flex-1 truncate font-medium text-secondary underline underline-offset-2"
              >
                {file.name}
              </a>
              <span className="shrink-0 text-muted-foreground">{`${file.pages} pg`}</span>
            </li>
          ))}
        </ul>

        {showActions && (
          <div className="grid grid-cols-2 gap-3">
            <Button
              onClick={() => decide(order, 'accept')}
              disabled={busy === order.id}
              className="h-12 bg-success font-bold text-success-foreground hover:bg-success/90"
            >
              Accept &amp; Print
            </Button>
            <Button
              onClick={() => decide(order, 'reject')}
              disabled={busy === order.id}
              variant="destructive"
              className="h-12 font-bold"
            >
              Reject
            </Button>
          </div>
        )}

        {order.status === 'accepted' && (
          <Button
            onClick={() => printFiles(order)}
            variant="outline"
            className="h-11 font-semibold"
          >
            Print Again
          </Button>
        )}
      </li>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="paid-heading">
        <h2 id="paid-heading" className="mb-3 text-lg font-bold">
          {`Paid Orders Waiting (${paidOrders.length})`}
        </h2>
        {paidOrders.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
            No paid orders waiting. New orders appear here automatically.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">{paidOrders.map((o) => renderOrder(o, true))}</ul>
        )}
      </section>

      {otherOrders.length > 0 && (
        <section aria-labelledby="history-heading">
          <h2 id="history-heading" className="mb-3 text-lg font-bold">
            Other Orders
          </h2>
          <ul className="flex flex-col gap-3">{otherOrders.map((o) => renderOrder(o, false))}</ul>
        </section>
      )}
    </div>
  )
}
