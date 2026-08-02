import { NextRequest, NextResponse } from 'next/server'
import { PDFDocument } from 'pdf-lib'
import {
  createOrder,
  calculatePrice,
  toPublic,
  type Order,
  type PrintType,
  type StoredFile,
} from '@/lib/store'

export const runtime = 'nodejs'

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB per file
const MAX_FILES = 10

const ALLOWED_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()

    const customerName = String(formData.get('customerName') || '').trim()
    const printType = String(formData.get('printType') || 'bw') as PrintType
    const copies = Math.max(1, Math.min(100, Number(formData.get('copies')) || 1))
    const docxPagesRaw = String(formData.get('docxPages') || '[]')

    if (!customerName || customerName.length > 100) {
      return NextResponse.json({ error: 'Please enter your name.' }, { status: 400 })
    }
    if (printType !== 'bw' && printType !== 'color') {
      return NextResponse.json({ error: 'Invalid print type.' }, { status: 400 })
    }

    let docxPages: number[] = []
    try {
      const parsed = JSON.parse(docxPagesRaw)
      if (Array.isArray(parsed)) docxPages = parsed.map((n) => Math.max(1, Math.min(500, Number(n) || 1)))
    } catch {
      docxPages = []
    }

    const fileEntries = formData.getAll('files').filter((f): f is File => f instanceof File)

    if (fileEntries.length === 0) {
      return NextResponse.json({ error: 'Please upload at least one file.' }, { status: 400 })
    }
    if (fileEntries.length > MAX_FILES) {
      return NextResponse.json({ error: `Maximum ${MAX_FILES} files allowed.` }, { status: 400 })
    }

    const files: StoredFile[] = []
    let docxIndex = 0

    for (const file of fileEntries) {
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `"${file.name}" is too large. Maximum 20MB per file.` },
          { status: 400 },
        )
      }
      if (!ALLOWED_TYPES.includes(file.type)) {
        return NextResponse.json(
          { error: `"${file.name}" is not a supported file type. Use PDF, JPG, PNG, or DOCX.` },
          { status: 400 },
        )
      }

      const buffer = Buffer.from(await file.arrayBuffer())
      let pages = 1

      if (file.type === 'application/pdf') {
        try {
          const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true })
          pages = pdf.getPageCount()
        } catch {
          return NextResponse.json(
            { error: `Could not read "${file.name}". Please upload a valid PDF.` },
            { status: 400 },
          )
        }
      } else if (
        file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ) {
        pages = docxPages[docxIndex] ?? 1
        docxIndex++
      }

      files.push({ name: file.name, type: file.type, size: file.size, pages, data: buffer })
    }

    const totalPages = files.reduce((sum, f) => sum + f.pages, 0)
    const price = calculatePrice(totalPages, printType, copies)

    const order: Order = {
      id: crypto.randomUUID(),
      customerName,
      printType,
      copies,
      totalPages,
      price,
      status: 'pending_payment',
      createdAt: Date.now(),
      files,
    }

    createOrder(order)

    return NextResponse.json({ order: toPublic(order) })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
