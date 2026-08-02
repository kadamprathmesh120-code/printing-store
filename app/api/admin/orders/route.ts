import { NextResponse } from 'next/server'
import { isAdmin } from '@/lib/admin-auth'
import { listOrders, toPublic } from '@/lib/store'

export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ orders: listOrders().map(toPublic) })
}
