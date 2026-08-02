import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Archivo } from 'next/font/google'
import './globals.css'

const _archivo = Archivo({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Quick Print Shop - Upload & Print',
  description:
    'Upload your files, pay via Paytm, and collect your prints at the counter. B&W ₹5/page, Colour ₹10/page.',
  generator: 'v0.app',
}

export const viewport: Viewport = {
  themeColor: '#f7f3e9',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="bg-background">
      <body className="antialiased font-sans">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
