import { NextRequest, NextResponse } from 'next/server'
import { getOrder, updateOrder, toPublic } from '@/lib/store'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const order = getOrder(id)
  if (!order) {
    return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
  }
  if (order.status !== 'pending_payment') {
    return NextResponse.json({ order: toPublic(order) })
  }
  const updated = updateOrder(id, { status: 'paid', paidAt: Date.now() })
  return NextResponse.json({ order: toPublic(updated!) })
}
