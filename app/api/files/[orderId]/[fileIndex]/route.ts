import { NextRequest, NextResponse } from 'next/server'
import { isAdmin } from '@/lib/admin-auth'
import { getOrder } from '@/lib/store'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ orderId: string; fileIndex: string }> },
) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orderId, fileIndex } = await params
  const order = getOrder(orderId)
  if (!order) {
    return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
  }

  const index = Number(fileIndex)
  const file = order.files[index]
  if (!file) {
    return NextResponse.json({ error: 'File not found.' }, { status: 404 })
  }

  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      'Content-Type': file.type,
      'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
      'Content-Length': String(file.size),
    },
  })
}
