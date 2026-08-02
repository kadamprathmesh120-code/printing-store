import { cookies } from 'next/headers'
import { createHmac } from 'crypto'

const COOKIE_NAME = 'print_admin_session'

function getPassword(): string {
  return process.env.ADMIN_PASSWORD || 'print123'
}

function getToken(): string {
  return createHmac('sha256', getPassword()).update('print-admin-session').digest('hex')
}

export function verifyPassword(password: string): boolean {
  return password === getPassword()
}

export async function setAdminSession() {
  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, getToken(), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days
  })
}

export async function clearAdminSession() {
  const cookieStore = await cookies()
  cookieStore.delete(COOKIE_NAME)
}

export async function isAdmin(): Promise<boolean> {
  const cookieStore = await cookies()
  return cookieStore.get(COOKIE_NAME)?.value === getToken()
}
