import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { Inter, Playfair_Display } from 'next/font/google';
import './globals.css';

// Theme D type system (cms.chem.dev/hhe-directory): Inter = body/sans,
// Playfair Display = display serif (practitioner names + page headings).
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});
const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-playfair',
  display: 'swap',
});
const geistMono = localFont({
  src: './fonts/GeistMonoVF.woff',
  variable: '--font-geist-mono',
  weight: '100 900',
});

export const metadata: Metadata = {
  title: 'HHE Directory',
  description: 'HHE-students-first practitioner directory.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable} ${geistMono.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
