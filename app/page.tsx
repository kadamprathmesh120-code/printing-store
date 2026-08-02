import { OrderFlow } from '@/components/order/order-flow'

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col px-4 pb-10">
      <header className="flex flex-col items-center gap-1 py-6 text-center">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-lg font-bold text-secondary-foreground">
            P
          </span>
          <h1 className="text-2xl font-bold tracking-tight">Quick Print Shop</h1>
        </div>
        <p className="text-sm text-muted-foreground text-balance">
          {'Upload your files, pay, and collect at the counter. B&W ₹5/page · Colour ₹10/page'}
        </p>
      </header>
      <OrderFlow />
    </main>
  )
}
