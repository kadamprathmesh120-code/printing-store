'use client'

import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'

export default function CounterPage() {
  const [url, setUrl] = useState('')

  useEffect(() => {
    setUrl(window.location.origin + '/')
  }, [])

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="flex items-center gap-2">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary text-xl font-bold text-secondary-foreground">
          P
        </span>
        <h1 className="text-3xl font-bold tracking-tight">Quick Print Shop</h1>
      </div>

      <p className="text-lg font-semibold text-balance">
        Scan this QR code to upload your file and print
      </p>

      <div className="rounded-2xl border-4 border-secondary bg-card p-6">
        {url ? (
          <QRCodeSVG value={url} size={280} />
        ) : (
          <div className="h-[280px] w-[280px] animate-pulse rounded-lg bg-muted" />
        )}
      </div>

      <ol className="flex flex-col gap-1 text-base text-muted-foreground">
        <li>1. Scan with your phone camera</li>
        <li>2. Upload your file and enter your name</li>
        <li>3. Pay via the QR shown on your phone</li>
        <li>4. Wait for your name to be called</li>
      </ol>

      <p className="text-sm text-muted-foreground">B&amp;W ₹5/page · Colour ₹10/page</p>
    </main>
  )
}
