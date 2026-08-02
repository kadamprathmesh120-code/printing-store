export type OrderStatus = 'pending_payment' | 'paid' | 'accepted' | 'rejected'
export type PrintType = 'bw' | 'color'

export const PRICE_PER_PAGE: Record<PrintType, number> = {
  bw: 5,
  color: 10,
}

export interface StoredFile {
  name: string
  type: string
  size: number
  pages: number
  data: Buffer
}

export interface Order {
  id: string
  customerName: string
  printType: PrintType
  copies: number
  totalPages: number
  price: number
  status: OrderStatus
  createdAt: number
  paidAt?: number
  decidedAt?: number
  files: StoredFile[]
}

// Public shape sent to clients (no file buffers)
export interface OrderPublic {
  id: string
  customerName: string
  printType: PrintType
  copies: number
  totalPages: number
  price: number
  status: OrderStatus
  createdAt: number
  paidAt?: number
  decidedAt?: number
  files: { name: string; type: string; size: number; pages: number }[]
}

const globalStore = globalThis as unknown as {
  __printOrders?: Map<string, Order>
}

function getStore(): Map<string, Order> {
  if (!globalStore.__printOrders) {
    globalStore.__printOrders = new Map()
  }
  return globalStore.__printOrders
}

export function createOrder(order: Order) {
  getStore().set(order.id, order)
}

export function getOrder(id: string): Order | undefined {
  return getStore().get(id)
}

export function listOrders(): Order[] {
  return Array.from(getStore().values()).sort((a, b) => b.createdAt - a.createdAt)
}

export function updateOrder(id: string, patch: Partial<Order>): Order | undefined {
  const order = getStore().get(id)
  if (!order) return undefined
  const updated = { ...order, ...patch }
  getStore().set(id, updated)
  return updated
}

export function toPublic(order: Order): OrderPublic {
  const { files, ...rest } = order
  return {
    ...rest,
    files: files.map((f) => ({
      name: f.name,
      type: f.type,
      size: f.size,
      pages: f.pages,
    })),
  }
}

export function calculatePrice(totalPages: number, printType: PrintType, copies: number): number {
  return totalPages * PRICE_PER_PAGE[printType] * copies
}
