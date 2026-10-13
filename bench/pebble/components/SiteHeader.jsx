import Link from 'next/link';

export default function SiteHeader() {
  return (
    <header className="top">
      <Link className="brand" href="/">Pebble</Link>
      <Link href="/pricing">Pricing</Link>
      <Link href="/about">About</Link>
      <Link href="/help">Help</Link>
      <Link className="btn" href="/login">Log in</Link>
    </header>
  );
}
