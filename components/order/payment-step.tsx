'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import type { OrderPublic } from '@/lib/store'

interface PaymentStepProps {
  order: OrderPublic
  onPaid: (order: OrderPublic) => void
}

export function PaymentStep({ order, onPaid }: PaymentStepProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function handlePaid() {
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch(`/api/orders/${order.id}/pay`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Something went wrong. Please try again.')
        return
      }
      onPaid(data.order)
    } catch {
      setError('Could not confirm. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Price summary */}
      <div className="rounded-xl border-2 border-secondary bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">Your Order Summary</h2>
        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="font-semibold">{order.customerName}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Files</dt>
            <dd className="font-semibold">{order.files.length}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Total pages</dt>
            <dd className="font-semibold">{order.totalPages}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Print type</dt>
            <dd className="font-semibold">
              {order.printType === 'bw' ? 'Black & White (₹5/page)' : 'Colour (₹10/page)'}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Copies</dt>
            <dd className="font-semibold">{order.copies}</dd>
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-border pt-3">
            <dt className="text-base font-bold">Total to Pay</dt>
            <dd className="text-2xl font-bold text-primary">{`₹${order.price}`}</dd>
          </div>
        </dl>
      </div>

      {/* Paytm QR */}
      <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-4">
        <p className="text-center text-base font-semibold text-balance">
          {`Kindly scan this QR with Paytm or any UPI app and pay ₹${order.price}`}
        </p>
        <Image
          src="/paytm-qr.png"
          alt="Paytm payment QR code - scan to pay"
          width={260}
          height={260}
          className="rounded-lg"
        />
        <p className="text-center text-sm text-muted-foreground text-pretty">
          After paying, please tap the button below. Thank you!
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm font-medium text-destructive">
          {error}
        </p>
      )}

      <Button
        onClick={handlePaid}
        disabled={submitting}
        size="lg"
        className="h-14 text-base font-bold"
      >
        {submitting ? 'Confirming...' : 'I Have Paid'}
      </Button>
    </div>
  )
}
