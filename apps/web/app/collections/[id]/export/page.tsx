'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Toasts';
import { api } from '@/lib/api';
import { newKey, PLATFORM_NAME } from '@/lib/format';
import { errorMessage, useCollection } from '@/lib/hooks';
import type { Platform } from '@/lib/types';

const CONNECT_MESSAGES: Record<string, string> = {
  denied: 'You cancelled the connection. Nothing was changed.',
  invalid_state: 'That sign-in link expired. Please try again.',
  no_channel: 'This Google account has no YouTube channel. Create one at youtube.com, then connect again.',
  missing_permission: 'We need permission to manage playlists. Please allow it when you connect.',
  not_allowlisted:
    'This app is in limited testing on that platform, and your account isn’t on the tester list yet.',
  error: 'Connecting failed. Please try again.',
  provider_error: 'The platform reported an error. Please try again.',
};

function LinkListView({ collectionId }: { collectionId: string }) {
  const toast = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ['links', collectionId],
    queryFn: () => api.links(collectionId),
  });
  const text = data?.items.map((i) => `${i.position}. ${i.title} (${i.show})\n   ${i.url}`).join('\n') ?? '';
  return (
    <div className="connect-card">
      <div className="connect-ic warn">
        <Icon name="info" />
      </div>
      <p className="sec-idx">Apple Podcasts</p>
      <h1 className="xp-title">
        A list of links, <em>not a playlist</em>
      </h1>
      <p className="xp-lede">
        Apple Podcasts doesn&apos;t let apps create playlists. Here are your episodes in order, as links you
        can open or keep.
      </p>
      {isLoading ? (
        <div className="link-list sk" style={{ height: 200 }} />
      ) : (
        <pre className="link-list" tabIndex={0}>
          {text}
        </pre>
      )}
      <div className="btn-row center">
        <button
          className="btn btn-primary"
          disabled={!text}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(
              () => toast('Copied. These are links, not a playlist'),
              () => toast('Copy failed. Select the text instead', { icon: 'alert' }),
            );
          }}
        >
          <Icon name="copy" /> Copy list
        </button>
      </div>
    </div>
  );
}

function ExportStart() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { data: col } = useCollection(id);
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers });
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections });
  const [view, setView] = useState<'choose' | 'links'>('choose');
  const [starting, setStarting] = useState<Platform | null>(null);
  // One key per visit: double-clicks and retries reuse the same export instead of creating two.
  const idemKey = useRef(newKey());
  const autoStarted = useRef(false);

  const start = useCallback(
    async (platform: Platform) => {
      if (platform === 'apple') return setView('links');
      const conn = connections.data?.connections.find((c) => c.platform === platform);
      if (!conn?.connected) {
        window.location.href = api.connectUrl(platform, `/collections/${id}/export?dest=${platform}`);
        return;
      }
      setStarting(platform);
      try {
        const job = await api.createExport({
          collectionId: id,
          destination: platform,
          idempotencyKey: `${idemKey.current}-${platform}`,
          playlistTitle: col?.name,
        });
        router.replace(`/exports/${job.id}`);
      } catch (err) {
        toast(errorMessage(err), { icon: 'alert' });
        setStarting(null);
      }
    },
    [connections.data, id, col?.name, router, toast],
  );

  // Returning from the provider's consent screen.
  useEffect(() => {
    const outcome = params.get('connect');
    const dest = params.get('dest') as Platform | null;
    if (!outcome || autoStarted.current || !connections.data) return;
    autoStarted.current = true;
    if (outcome === 'connected' && dest) {
      toast(`${PLATFORM_NAME[dest]} connected`);
      void start(dest);
    } else {
      toast(CONNECT_MESSAGES[outcome] ?? CONNECT_MESSAGES.error!, { icon: 'alert', durationMs: 8000 });
    }
  }, [params, connections.data, start, toast]);

  const caps = providers.data?.providers ?? [];
  const cards: Array<{ platform: Platform; line: string }> = [
    { platform: 'youtube', line: 'Creates a private playlist of the matching videos on your channel.' },
    { platform: 'spotify', line: 'Creates a private playlist with the matching podcast episodes.' },
    {
      platform: 'apple',
      line: 'Apple doesn’t allow apps to create playlists. You get a list of links instead.',
    },
  ];

  return (
    <section className="xp">
      <div className="xp-bg" aria-hidden="true" />
      <div className="wrap xp-wrap">
        <header className="xp-head">
          <Link className="back-link" href={`/collections/${id}`}>
            <Icon name="arrowL" /> {col?.name ?? 'Collection'}
          </Link>
        </header>
        {view === 'links' ? (
          <LinkListView collectionId={id} />
        ) : (
          <>
            <div className="xp-title-row">
              <p className="sec-idx">Export</p>
              <h1 className="xp-title">
                Where do you <em>listen?</em>
              </h1>
              <p className="xp-lede">
                We&apos;ll find each of the {col?.items.length ?? ''} episodes on the app you pick.
                You&apos;ll review every uncertain match before anything is added.
              </p>
            </div>
            <div className="dest-grid">
              {cards.map(({ platform, line }) => {
                const cap = caps.find((c) => c.platform === platform);
                const conn = connections.data?.connections.find((c) => c.platform === platform);
                const enabled = platform === 'apple' || cap?.export === 'playlist';
                return (
                  <button
                    key={platform}
                    className={`dest${enabled ? '' : ' dest-limited'}`}
                    disabled={!enabled || starting !== null}
                    onClick={() => void start(platform)}
                  >
                    <span className="dest-glow" aria-hidden="true" />
                    <span className="dest-top">
                      <span className="src-tag solid">{PLATFORM_NAME[platform]}</span>
                      <span className={`dest-note${enabled ? '' : ' warn'}`}>
                        <Icon name={enabled ? 'check' : 'info'} />
                        {platform === 'apple'
                          ? 'Link list'
                          : enabled
                            ? conn?.connected
                              ? `Connected${conn.displayName ? ` as ${conn.displayName}` : ''}`
                              : 'Connect to continue'
                            : 'Not available yet'}
                      </span>
                    </span>
                    <b className="dest-name">{PLATFORM_NAME[platform]}</b>
                    <span className="dest-line">{line}</span>
                    <span className="dest-foot">
                      <span className="dest-est">
                        {platform === 'youtube' && providers.data?.youtubeQuotaRemaining != null
                          ? `Daily capacity left: ${Math.floor(providers.data.youtubeQuotaRemaining / 150)} episodes`
                          : ''}
                      </span>
                      <span className="dest-go">
                        {starting === platform ? <span className="spin" /> : <Icon name="arrow" />}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export default function ExportStartPage() {
  return (
    <Suspense>
      <ExportStart />
    </Suspense>
  );
}
