import { NextRequest, NextResponse } from 'next/server'
import { isAdmin } from '@/lib/admin-auth'
import { getOrder, updateOrder, toPublic } from '@/lib/store'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  const order = getOrder(id)
  if (!order) {
    return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
  }

  let action: string
  try {
    const body = await request.json()
    action = body.action
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  if (action !== 'accept' && action !== 'reject') {
    return NextResponse.json({ error: 'Invalid action.' }, { status: 400 })
  }

  const updated = updateOrder(id, {
    status: action === 'accept' ? 'accepted' : 'rejected',
    decidedAt: Date.now(),
  })

  return NextResponse.json({ order: toPublic(updated!) })
}
