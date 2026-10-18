'use client';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <section className="wrap page-head">
      <p className="sec-idx">Something went wrong</p>
      <h1 className="page-title">
        That didn&apos;t <em>work.</em>
      </h1>
      <p className="page-lede">An unexpected error occurred. Your library is safe.</p>
      <button className="btn btn-primary" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
