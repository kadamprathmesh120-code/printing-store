'use client'

import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import type { OrderPublic } from '@/lib/store'

const fetcher = (url: string) => fetch(url).then((res) => res.json())

interface StatusStepProps {
  orderId: string
  initialOrder: OrderPublic
  onStartNew: () => void
}

export function StatusStep({ orderId, initialOrder, onStartNew }: StatusStepProps) {
  const { data } = useSWR<{ order: OrderPublic }>(`/api/orders/${orderId}`, fetcher, {
    refreshInterval: (latest) => {
      const status = latest?.order?.status
      return status === 'accepted' || status === 'rejected' ? 0 : 3000
    },
    fallbackData: { order: initialOrder },
  })

  const order = data?.order ?? initialOrder

  if (order.status === 'accepted') {
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border-2 border-success bg-card p-6 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-success text-3xl font-bold text-success-foreground">
          {'✓'}
        </div>
        <h2 className="text-2xl font-bold text-balance">{`Thank you, ${order.customerName}!`}</h2>
        <p className="text-base text-pretty leading-relaxed">
          Your payment is confirmed and your print is being prepared right now.
        </p>
        <p className="rounded-lg bg-accent px-4 py-3 text-base font-bold">
          Please come to the counter to collect your prints.
        </p>
        <Button onClick={onStartNew} variant="outline" size="lg" className="mt-2 h-12 w-full">
          Print Something Else
        </Button>
      </div>
    )
  }

  if (order.status === 'rejected') {
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border-2 border-destructive bg-card p-6 text-center">
        <h2 className="text-2xl font-bold text-balance">We&apos;re sorry</h2>
        <p className="text-base text-pretty leading-relaxed">
          {`Sorry ${order.customerName}, we could not process this order. Please come to the counter and we will help you right away, or check if the payment went through.`}
        </p>
        <Button onClick={onStartNew} size="lg" className="mt-2 h-12 w-full">
          Try Again
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border-2 border-secondary bg-card p-6 text-center">
      <div
        className="h-12 w-12 animate-spin rounded-full border-4 border-muted border-t-primary"
        aria-hidden="true"
      />
      <h2 className="text-2xl font-bold text-balance">Payment confirmation pending</h2>
      <p className="text-base text-pretty leading-relaxed">
        {`Thanks, ${order.customerName}. Your payment has been sent to the shop for verification. Printing starts once it is confirmed.`}
      </p>
      <p className="text-sm text-muted-foreground">
        This screen will update automatically. Please keep it open.
      </p>
      <dl className="w-full rounded-lg bg-muted p-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Amount paid</dt>
          <dd className="font-bold">{`₹${order.price}`}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Pages</dt>
          <dd className="font-bold">{`${order.totalPages} × ${order.copies} ${order.copies > 1 ? 'copies' : 'copy'}`}</dd>
        </div>
      </dl>
    </div>
  )
}
