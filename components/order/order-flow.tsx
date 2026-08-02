'use client'

import { useState } from 'react'
import { UploadStep } from './upload-step'
import { PaymentStep } from './payment-step'
import { StatusStep } from './status-step'
import type { OrderPublic } from '@/lib/store'

type Step = 'upload' | 'payment' | 'status'

export function OrderFlow() {
  const [step, setStep] = useState<Step>('upload')
  const [order, setOrder] = useState<OrderPublic | null>(null)

  return (
    <div className="flex flex-col gap-4">
      {/* Progress indicator */}
      <div className="flex items-center gap-2" aria-hidden="true">
        {(['upload', 'payment', 'status'] as Step[]).map((s, i) => {
          const stepIndex = ['upload', 'payment', 'status'].indexOf(step)
          const active = i <= stepIndex
          return (
            <div
              key={s}
              className={`h-1.5 flex-1 rounded-full ${active ? 'bg-primary' : 'bg-muted'}`}
            />
          )
        })}
      </div>

      {step === 'upload' && (
        <UploadStep
          onOrderCreated={(o) => {
            setOrder(o)
            setStep('payment')
          }}
        />
      )}

      {step === 'payment' && order && (
        <PaymentStep
          order={order}
          onPaid={(o) => {
            setOrder(o)
            setStep('status')
          }}
        />
      )}

      {step === 'status' && order && (
        <StatusStep
          orderId={order.id}
          initialOrder={order}
          onStartNew={() => {
            setOrder(null)
            setStep('upload')
          }}
        />
      )}
    </div>
  )
}
