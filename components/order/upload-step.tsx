'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { OrderPublic } from '@/lib/store'

const PRICE = { bw: 5, color: 10 }

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.docx'
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

interface UploadStepProps {
  onOrderCreated: (order: OrderPublic) => void
}

export function UploadStep({ onOrderCreated }: UploadStepProps) {
  const [name, setName] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [docxPages, setDocxPages] = useState<Record<number, number>>({})
  const [printType, setPrintType] = useState<'bw' | 'color'>('bw')
  const [copies, setCopies] = useState(1)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function addFiles(list: FileList | null) {
    if (!list) return
    setError('')
    setFiles((prev) => [...prev, ...Array.from(list)].slice(0, 10))
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index))
    setDocxPages((prev) => {
      const next: Record<number, number> = {}
      Object.entries(prev).forEach(([k, v]) => {
        const i = Number(k)
        if (i < index) next[i] = v
        else if (i > index) next[i - 1] = v
      })
      return next
    })
  }

  async function handleSubmit() {
    setError('')
    if (!name.trim()) {
      setError('Please enter your name so we can call you at the counter.')
      return
    }
    if (files.length === 0) {
      setError('Please add at least one file to print.')
      return
    }

    setSubmitting(true)
    try {
      const formData = new FormData()
      formData.set('customerName', name.trim())
      formData.set('printType', printType)
      formData.set('copies', String(copies))

      const docxCounts: number[] = []
      files.forEach((file, i) => {
        formData.append('files', file)
        if (file.type === DOCX_TYPE || file.name.toLowerCase().endsWith('.docx')) {
          docxCounts.push(docxPages[i] || 1)
        }
      })
      formData.set('docxPages', JSON.stringify(docxCounts))

      const res = await fetch('/api/orders', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Something went wrong. Please try again.')
        return
      }
      onOrderCreated(data.order)
    } catch {
      setError('Could not upload. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const isDocx = (f: File) => f.type === DOCX_TYPE || f.name.toLowerCase().endsWith('.docx')

  return (
    <div className="flex flex-col gap-6">
      {/* Name */}
      <div className="flex flex-col gap-2">
        <label htmlFor="customer-name" className="text-sm font-semibold uppercase tracking-wide">
          Step 1: Your Name
        </label>
        <input
          id="customer-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Rahul Sharma"
          maxLength={100}
          className="h-12 rounded-lg border-2 border-secondary bg-card px-4 text-base focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <p className="text-sm text-muted-foreground">We&apos;ll call this name at the counter.</p>
      </div>

      {/* Files */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold uppercase tracking-wide">Step 2: Upload Files</span>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="sr-only"
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex h-24 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-secondary bg-card text-secondary transition-colors hover:bg-accent"
        >
          <span className="text-base font-bold">Tap to upload files</span>
          <span className="text-sm text-muted-foreground">PDF, JPG, PNG, or DOCX</span>
        </button>

        {files.length > 0 && (
          <ul className="flex flex-col gap-2">
            {files.map((file, i) => (
              <li
                key={`${file.name}-${i}`}
                className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    className="shrink-0 rounded-md px-2 py-1 text-sm font-semibold text-destructive"
                    aria-label={`Remove ${file.name}`}
                  >
                    Remove
                  </button>
                </div>
                {isDocx(file) && (
                  <div className="flex items-center gap-2">
                    <label htmlFor={`docx-pages-${i}`} className="text-sm text-muted-foreground">
                      Number of pages:
                    </label>
                    <input
                      id={`docx-pages-${i}`}
                      type="number"
                      min={1}
                      max={500}
                      value={docxPages[i] || 1}
                      onChange={(e) =>
                        setDocxPages((prev) => ({ ...prev, [i]: Math.max(1, Number(e.target.value) || 1) }))
                      }
                      className="h-9 w-20 rounded-md border border-input bg-card px-2 text-sm"
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Print type */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold uppercase tracking-wide">Step 3: Print Type</span>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setPrintType('bw')}
            className={`flex flex-col items-center gap-1 rounded-lg border-2 p-4 transition-colors ${
              printType === 'bw'
                ? 'border-primary bg-accent'
                : 'border-border bg-card hover:bg-muted'
            }`}
            aria-pressed={printType === 'bw'}
          >
            <span className="text-base font-bold">Black &amp; White</span>
            <span className="text-sm text-muted-foreground">{`₹${PRICE.bw} per page`}</span>
          </button>
          <button
            type="button"
            onClick={() => setPrintType('color')}
            className={`flex flex-col items-center gap-1 rounded-lg border-2 p-4 transition-colors ${
              printType === 'color'
                ? 'border-primary bg-accent'
                : 'border-border bg-card hover:bg-muted'
            }`}
            aria-pressed={printType === 'color'}
          >
            <span className="text-base font-bold">Colour</span>
            <span className="text-sm text-muted-foreground">{`₹${PRICE.color} per page`}</span>
          </button>
        </div>
      </div>

      {/* Copies */}
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-semibold uppercase tracking-wide">Copies</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setCopies((c) => Math.max(1, c - 1))}
            className="flex h-11 w-11 items-center justify-center rounded-lg border-2 border-secondary bg-card text-xl font-bold text-secondary"
            aria-label="Decrease copies"
          >
            {'−'}
          </button>
          <span className="w-8 text-center text-lg font-bold" aria-live="polite">
            {copies}
          </span>
          <button
            type="button"
            onClick={() => setCopies((c) => Math.min(100, c + 1))}
            className="flex h-11 w-11 items-center justify-center rounded-lg border-2 border-secondary bg-card text-xl font-bold text-secondary"
            aria-label="Increase copies"
          >
            +
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm font-medium text-destructive">
          {error}
        </p>
      )}

      <Button
        onClick={handleSubmit}
        disabled={submitting}
        size="lg"
        className="h-14 text-base font-bold"
      >
        {submitting ? 'Uploading your files...' : 'Continue to Price & Payment'}
      </Button>
    </div>
  )
}
