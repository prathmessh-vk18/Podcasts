import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Footer, TabBar, TopBar } from '@/components/Shell';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Tangent: discover ideas, listen anywhere', template: '%s · Tangent' },
  description:
    'Discover learning-focused podcast episodes across YouTube, Spotify and Apple Podcasts, save them in one place, and take them to the app you listen in.',
};

export const viewport: Viewport = { themeColor: '#0c0b10', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="preconnect" href="https://is1-ssl.mzstatic.com" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- app-wide font loaded once in the root layout */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400..700&family=Google+Sans+Flex:opsz,wdth,wght@6..144,25..151,100..1000&display=swap"
        />
      </head>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <Providers>
          <TopBar />
          <main id="main" tabIndex={-1}>
            {children}
          </main>
          <Footer />
          <TabBar />
        </Providers>
      </body>
    </html>
  );
}
