import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="wrap page-head">
      <p className="sec-idx">404</p>
      <h1 className="page-title">
        Lost the <em>thread.</em>
      </h1>
      <p className="page-lede">This page doesn&apos;t exist.</p>
      <div className="btn-row">
        <Link className="btn btn-primary" href="/">
          Back to Discover
        </Link>
      </div>
    </section>
  );
}
