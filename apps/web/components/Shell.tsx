'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSaved } from '@/lib/hooks';
import { Brand } from './Brand';
import { Icon } from './Icon';

const TABS = [
  { href: '/', label: 'Discover', icon: 'compass' as const, match: (p: string) => p === '/' },
  {
    href: '/library',
    label: 'Library',
    icon: 'library' as const,
    match: (p: string) =>
      p.startsWith('/library') || p.startsWith('/collections') || p.startsWith('/exports'),
  },
];

function useScrolled() {
  useEffect(() => {
    const on = () => document.body.classList.toggle('scrolled', window.scrollY > 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
}

export function TopBar() {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  const savedCount = Object.keys(useSaved().data?.saved ?? {}).length;
  useScrolled();

  useLayoutEffect(() => {
    const on = navRef.current?.querySelector<HTMLElement>('a.on');
    setPill(on ? { x: on.offsetLeft, w: on.offsetWidth } : null);
  }, [pathname, savedCount]);

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="brand-link" aria-label="Tangent home">
          <Brand />
        </Link>
        <nav className="nav-tabs" aria-label="Primary" ref={navRef}>
          <span
            className="nav-pill"
            aria-hidden="true"
            style={pill ? { opacity: 1, width: pill.w, transform: `translateX(${pill.x}px)` } : undefined}
          />
          {TABS.map((t) => {
            const on = t.match(pathname);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={on ? 'on' : ''}
                aria-current={on ? 'page' : undefined}
              >
                {t.label}
                {t.href === '/library' && savedCount > 0 && <span className="nav-badge">{savedCount}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="topbar-right">
          <Link className="icon-btn" href="/#search" aria-label="Search">
            <Icon name="search" />
          </Link>
        </div>
      </div>
    </header>
  );
}

export function TabBar() {
  const pathname = usePathname();
  const savedCount = Object.keys(useSaved().data?.saved ?? {}).length;
  return (
    <nav className="tabbar" aria-label="Primary (mobile)">
      {TABS.map((t) => {
        const on = t.match(pathname);
        return (
          <Link key={t.href} href={t.href} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>
            <Icon name={t.icon} />
            <span>{t.label}</span>
            {t.href === '/library' && savedCount > 0 && <span className="nav-badge">{savedCount}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

export function Footer() {
  return (
    <footer className="site-foot">
      <div className="wrap foot-inner">
        <div className="foot-brand">
          <Brand />
          <p>Find anywhere. Curate once. Listen anywhere supported.</p>
        </div>
        <div className="foot-col">
          <h4>About the numbers</h4>
          <p>
            Popularity always comes from one platform and is labelled with its source. We never rank YouTube
            views against Spotify charts or Apple ratings. If a platform doesn&apos;t share a number, we say
            so.
          </p>
        </div>
        <div className="foot-col">
          <h4>Your data</h4>
          <p>
            Connected accounts are used only to create the playlists you ask for. Disconnect at any time from
            Library.
          </p>
        </div>
      </div>
    </footer>
  );
}
