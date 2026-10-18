'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cover } from '@/components/Cover';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Toasts';
import { api, ApiError } from '@/lib/api';
import { clock, date, PLATFORM_NAME } from '@/lib/format';
import { errorMessage, keys } from '@/lib/hooks';
import type { ExportItem, ExportJob } from '@/lib/types';

const ACTIVE = new Set(['planning', 'running']);

function Ring({ value }: { value: number }) {
  const r = 18,
    c = 2 * Math.PI * r;
  return (
    <span className="ring">
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r={r} className="ring-bg" />
        <circle
          cx="22"
          cy="22"
          r={r}
          className="ring-fg"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - value)}
        />
      </svg>
      <b>
        {Math.round(value * 100)}
        <small>%</small>
      </b>
    </span>
  );
}

function Steps({ status }: { status: ExportJob['status'] }) {
  const order = ['planning', 'review', 'adding', 'done'];
  const cur =
    status === 'planning'
      ? 0
      : status === 'needs_review' || status === 'ready'
        ? 1
        : status === 'running'
          ? 2
          : 3;
  const labels = ['Match', 'Review', 'Add', 'Done'];
  return (
    <ol className="stepper" aria-label="Export progress">
      {order.map((k, i) => (
        <li
          key={k}
          className={i < cur ? 'done' : i === cur ? 'cur' : ''}
          aria-current={i === cur ? 'step' : undefined}
        >
          <span className="st-dot">{i < cur ? <Icon name="check" /> : i + 1}</span>
          <span className="st-l">{labels[i]}</span>
        </li>
      ))}
    </ol>
  );
}

function ReviewCard({
  item,
  destination,
  onDecide,
  busy,
}: {
  item: ExportItem;
  destination: ExportJob['destination'];
  onDecide: (d: 'accept' | 'reject' | null) => void;
  busy: boolean;
}) {
  const ep = item.episode;
  const cand = item.match.candidate;
  return (
    <article className={`rv-card${item.decision ? ` dec-${item.decision}` : ''}`}>
      <div className="rv-pair">
        <div className="rv-side">
          <p className="rv-k">In your collection</p>
          <div className="rv-ep">
            <span className="rv-art lg">{ep && <Cover url={ep.artworkUrl} name={ep.show} size={100} />}</span>
            <span>
              <b>{ep?.title}</b>
              <small>{ep?.show}</small>
              <small>
                {clock(ep?.durationSec)} · {date(ep?.publishedAt)} · {ep && PLATFORM_NAME[ep.platform]}
              </small>
            </span>
          </div>
        </div>
        <div className="rv-mid">
          <Ring value={item.match.confidence} />
          <span className="rv-mid-l">confidence</span>
        </div>
        <div className="rv-side">
          <p className="rv-k">Best match on {PLATFORM_NAME[destination]}</p>
          {cand && (
            <div className="rv-ep">
              <span className="rv-art lg">
                <Cover url={cand.artworkUrl} name={cand.show} size={100} />
              </span>
              <span>
                <b>{cand.title}</b>
                <small>{cand.show}</small>
                <small>
                  {clock(cand.durationSec)} · {date(cand.publishedAt)}
                </small>
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="rv-why">
        <ul className="evidence" role="list">
          {item.match.evidence
            .filter((e) => e.result !== 'missing')
            .map((e) => (
              <li key={e.field} className={e.result === 'mismatch' ? 'bad' : 'ok'} title={e.detail}>
                <Icon name={e.result === 'mismatch' ? 'x' : 'check'} />
                {e.field.replace('_', ' ')}
              </li>
            ))}
        </ul>
        <p>
          {item.match.evidence.find((e) => e.result === 'mismatch')?.detail ??
            item.match.evidence.find((e) => e.result === 'partial')?.detail ??
            'Some details differ.'}
        </p>
      </div>
      <div className="rv-actions" role="group" aria-label={`Decision for ${ep?.title}`}>
        <button
          className={`btn btn-sm ${item.decision === 'accept' ? 'btn-primary' : 'btn-ghost'}`}
          aria-pressed={item.decision === 'accept'}
          disabled={busy}
          onClick={() => onDecide(item.decision === 'accept' ? null : 'accept')}
        >
          <Icon name="check" /> Use this match
        </button>
        <button
          className={`btn btn-sm ${item.decision === 'reject' ? 'btn-danger' : 'btn-ghost'}`}
          aria-pressed={item.decision === 'reject'}
          disabled={busy}
          onClick={() => onDecide(item.decision === 'reject' ? null : 'reject')}
        >
          <Icon name="x" /> Skip this episode
        </button>
        {cand && (
          <a className="btn btn-sm btn-text" href={cand.url} target="_blank" rel="noopener noreferrer">
            <Icon name="ext" /> Compare on {PLATFORM_NAME[destination]}
          </a>
        )}
      </div>
    </article>
  );
}

function Row({ item, note }: { item: ExportItem; note: string }) {
  const ep = item.episode;
  return (
    <div className="rv-row">
      <span className="rv-art">{ep && <Cover url={ep.artworkUrl} name={ep.show} size={100} />}</span>
      <span className="rv-txt">
        <b>{ep?.title}</b>
        <small>{note}</small>
      </span>
      {ep && (
        <a className="btn btn-sm btn-ghost" href={ep.url} target="_blank" rel="noopener noreferrer">
          <Icon name="ext" /> {PLATFORM_NAME[ep.platform]}
        </a>
      )}
    </div>
  );
}

export default function ExportPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const {
    data: job,
    error,
    isLoading,
  } = useQuery({
    queryKey: keys.exportJob(id),
    queryFn: () => api.exportJob(id),
    // Poll while the server is working; polling also restarts a stalled worker.
    refetchInterval: (q) => (q.state.data && ACTIVE.has(q.state.data.status) ? 1500 : false),
  });

  const act = async (fn: () => Promise<ExportJob>) => {
    setBusy(true);
    try {
      qc.setQueryData(keys.exportJob(id), await fn());
    } catch (err) {
      toast(errorMessage(err), { icon: 'alert', durationMs: 7000 });
      void qc.invalidateQueries({ queryKey: keys.exportJob(id) });
    } finally {
      setBusy(false);
    }
  };

  if (isLoading)
    return (
      <section className="xp">
        <div className="wrap xp-wrap">
          <div className="sk" style={{ height: 320, borderRadius: 30 }} />
        </div>
      </section>
    );
  if (error || !job) {
    return (
      <section className="wrap page-head">
        <h1 className="page-title">
          Export <em>not found</em>
        </h1>
        <p className="page-lede">
          {error instanceof ApiError ? error.message : 'It may belong to another browser session.'}
        </p>
        <Link className="btn btn-primary" href="/library">
          Back to library
        </Link>
      </section>
    );
  }

  const dest = PLATFORM_NAME[job.destination];
  const reviews = job.items.filter((i) => i.kind === 'review');
  const unavailable = job.items.filter((i) => i.kind === 'unavailable');
  const duplicates = job.items.filter((i) => i.kind === 'duplicate');
  const ready = job.items.filter((i) => i.kind === 'ready');
  const failed = job.items.filter((i) => i.state === 'failed');
  const added = job.items.filter((i) => i.state === 'added');
  const progress =
    job.summary.toAdd + job.summary.added > 0
      ? job.summary.added / (job.summary.toAdd + job.summary.added)
      : 0;

  return (
    <section className="xp">
      <div className="xp-bg" aria-hidden="true" />
      <div className="wrap xp-wrap">
        <header className="xp-head">
          {job.collectionId ? (
            <Link className="back-link" href={`/collections/${job.collectionId}`}>
              <Icon name="arrowL" /> Collection
            </Link>
          ) : (
            <span />
          )}
          <Steps status={job.status} />
        </header>

        {job.status === 'planning' && (
          <div className="xp-title-row">
            <div className="oauth-spin" style={{ margin: '0 auto 24px' }} aria-hidden="true" />
            <p className="sec-idx">Matching</p>
            <h1 className="xp-title">
              Finding each episode on <em>{dest}</em>
            </h1>
            <p className="xp-lede">
              Checking show, title, length and release date. This takes a few seconds per episode.
            </p>
          </div>
        )}

        {(job.status === 'needs_review' || job.status === 'ready') && (
          <>
            <div className="xp-title-row">
              <p className="sec-idx">Review</p>
              <h1 className="xp-title">
                Check before we <em>add anything</em>
              </h1>
              <p className="xp-lede">
                Nothing has been added to {dest} yet. Uncertain matches need your decision. We won&apos;t
                guess for you.
              </p>
            </div>
            <div className="tally">
              <span className="t-ready">
                <b>{job.summary.toAdd}</b> will be added
              </span>
              <span className={`t-review${job.summary.pendingReview ? ' pulse' : ''}`}>
                <b>{job.summary.pendingReview}</b> to review
              </span>
              <span className="t-none">
                <b>{job.summary.skipped.unavailable + job.summary.skipped.rejected}</b> skipped
              </span>
              <span className="t-dup">
                <b>{job.summary.skipped.duplicate}</b> duplicate
                {job.summary.skipped.duplicate === 1 ? '' : 's'}
              </span>
            </div>
            {reviews.length > 0 && (
              <section className="rv-sec">
                <h2 className="rv-h">
                  <Icon name="alert" /> Needs your review <span>{reviews.length}</span>
                </h2>
                {reviews.length > 1 && (
                  <button
                    className="btn btn-sm btn-text"
                    disabled={busy}
                    onClick={() =>
                      act(() =>
                        api.decide(
                          id,
                          reviews.map((r) => ({ itemId: r.id, decision: 'reject' })),
                        ),
                      )
                    }
                  >
                    Skip all uncertain
                  </button>
                )}
                {reviews.map((item) => (
                  <ReviewCard
                    key={item.id}
                    item={item}
                    destination={job.destination}
                    busy={busy}
                    onDecide={(d) => act(() => api.decide(id, [{ itemId: item.id, decision: d }]))}
                  />
                ))}
              </section>
            )}
            {unavailable.length > 0 && (
              <section className="rv-sec">
                <h2 className="rv-h">
                  <Icon name="x" /> Not on {dest} <span>{unavailable.length}</span>
                </h2>
                <p className="rv-sub">
                  We couldn&apos;t find these on {dest}. They won&apos;t be added, and won&apos;t be counted
                  as transferred.
                </p>
                {unavailable.map((i) => (
                  <Row
                    key={i.id}
                    item={i}
                    note={`${i.episode?.show ?? ''} · probably only on ${i.episode ? PLATFORM_NAME[i.episode.platform] : 'its source'}`}
                  />
                ))}
              </section>
            )}
            {duplicates.length > 0 && (
              <section className="rv-sec">
                <h2 className="rv-h">
                  <Icon name="copy" /> Duplicates <span>{duplicates.length}</span>
                </h2>
                {duplicates.map((i) => (
                  <Row
                    key={i.id}
                    item={i}
                    note="Same episode saved from another source. It will only be added once."
                  />
                ))}
              </section>
            )}
            {ready.length > 0 && (
              <details className="rv-sec rv-ready" open={ready.length <= 4}>
                <summary className="rv-h">
                  <Icon name="check" /> Ready to add <span>{ready.length}</span>
                  <Icon name="down" className="chev" />
                </summary>
                {ready.map((i) => (
                  <div key={i.id} className="rv-row">
                    <span className="rv-art">
                      {i.episode && <Cover url={i.episode.artworkUrl} name={i.episode.show} size={100} />}
                    </span>
                    <span className="rv-txt">
                      <b>{i.episode?.title}</b>
                      <small>{i.match.candidate?.title}</small>
                    </span>
                    <span className={`match-pill m-${i.match.status}`}>
                      {i.match.status === 'native'
                        ? `Already on ${dest}`
                        : i.match.status === 'exact'
                          ? 'Exact match'
                          : `Likely match · ${Math.round(i.match.confidence * 100)}%`}
                    </span>
                  </div>
                ))}
              </details>
            )}
            <div className="xp-sticky">
              <div className="pl-name">
                <span>New private playlist</span>
                <b>{job.playlist.title}</b>
              </div>
              <button
                className="btn btn-primary btn-lg"
                disabled={busy || job.status !== 'ready'}
                onClick={() => act(() => api.execute(id))}
              >
                {busy ? (
                  <span className="spin" />
                ) : job.summary.pendingReview ? (
                  `Review ${job.summary.pendingReview} more to continue`
                ) : (
                  `Add ${job.summary.toAdd} episode${job.summary.toAdd === 1 ? '' : 's'} to ${dest}`
                )}
              </button>
            </div>
          </>
        )}

        {job.status === 'running' && (
          <div className="result">
            <div className="result-ring">
              <svg viewBox="0 0 200 200" aria-hidden="true">
                <circle cx="100" cy="100" r="88" className="rr-bg" />
                <circle
                  cx="100"
                  cy="100"
                  r="88"
                  className="rr-fg"
                  strokeDasharray={2 * Math.PI * 88}
                  strokeDashoffset={2 * Math.PI * 88 * (1 - progress)}
                />
              </svg>
              <div className="rr-center">
                <b>{job.summary.added}</b>
                <small>of {job.summary.added + job.summary.toAdd}</small>
              </div>
            </div>
            <p className="sec-idx">Adding to {dest}</p>
            <h1 className="xp-title">
              Adding episodes<em>…</em>
            </h1>
            <p className="xp-lede">
              You can leave this page. The export keeps going and you can come back to it from your
              collection.
            </p>
          </div>
        )}

        {(job.status === 'completed' || job.status === 'partial' || job.status === 'failed') && (
          <div className="result">
            <div className={`result-ring done${failed.length ? ' partial' : ''}`}>
              <svg viewBox="0 0 200 200" aria-hidden="true">
                <circle cx="100" cy="100" r="88" className="rr-bg" />
                <circle
                  cx="100"
                  cy="100"
                  r="88"
                  className="rr-fg"
                  strokeDasharray={2 * Math.PI * 88}
                  strokeDashoffset={
                    2 * Math.PI * 88 * (1 - added.length / Math.max(1, added.length + failed.length))
                  }
                />
              </svg>
              <div className="rr-center">
                <b>{added.length}</b>
                <small>of {added.length + failed.length}</small>
              </div>
            </div>
            <p className="sec-idx">
              {job.status === 'completed'
                ? 'Export complete'
                : job.status === 'partial'
                  ? 'Finished, with issues'
                  : 'Export failed'}
            </p>
            <h1 className="xp-title">
              {job.status === 'completed' ? (
                <>
                  All {added.length} <em>added</em>
                </>
              ) : job.items.length === 0 ? (
                <>
                  Couldn&apos;t <em>match</em>
                </>
              ) : (
                <>
                  {added.length} of {added.length + failed.length} <em>added</em>
                </>
              )}
            </h1>
            <p className="xp-lede">
              {job.error?.message ??
                (job.playlist.url ? `Your private playlist “${job.playlist.title}” is on ${dest}.` : '')}
            </p>
            <div className="btn-row center">
              {job.playlist.url && (
                <a
                  className="btn btn-primary"
                  href={job.playlist.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="ext" /> Open in {dest}
                </a>
              )}
              {(job.status === 'partial' || job.status === 'failed') && (job.error?.retryable ?? true) && (
                <button className="btn btn-ghost" disabled={busy} onClick={() => act(() => api.retry(id))}>
                  <Icon name="retry" /> Retry failed
                </button>
              )}
              {job.error?.kind === 'auth_revoked' && (
                <a className="btn btn-ghost" href={api.connectUrl(job.destination, `/exports/${id}`)}>
                  Reconnect {dest}
                </a>
              )}
            </div>
            <div className="result-cols">
              {failed.length > 0 && (
                <section className="res-sec res-fail">
                  <h2 className="rv-h">
                    <Icon name="alert" /> Couldn&apos;t add <span>{failed.length}</span>
                  </h2>
                  {failed.map((i) => (
                    <Row key={i.id} item={i} note={i.lastError?.message ?? 'Failed'} />
                  ))}
                </section>
              )}
              {added.length > 0 && (
                <section className="res-sec res-ok">
                  <h2 className="rv-h">
                    <Icon name="check" /> Added <span>{added.length}</span>
                  </h2>
                  <div className="added-grid">
                    {added.map((i, k) => (
                      <span
                        key={i.id}
                        className="added-chip"
                        style={{ ['--i' as string]: k }}
                        title={i.episode?.title}
                      >
                        {i.episode && <Cover url={i.episode.artworkUrl} name={i.episode.show} size={100} />}
                      </span>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
        )}

        {job.status === 'cancelled' && (
          <div className="xp-title-row">
            <h1 className="xp-title">
              Export <em>cancelled</em>
            </h1>
            <p className="xp-lede">
              Nothing more will be added. Start a new export from your collection anytime.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
