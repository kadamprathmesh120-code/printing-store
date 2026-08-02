import { NextRequest, NextResponse } from 'next/server'
import { verifyPassword, setAdminSession, isAdmin } from '@/lib/admin-auth'

export async function GET() {
  return NextResponse.json({ authenticated: await isAdmin() })
}

export async function POST(request: NextRequest) {
  try {
    const { password } = await request.json()
    if (typeof password !== 'string' || !verifyPassword(password)) {
      return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 })
    }
    await setAdminSession()
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
}
