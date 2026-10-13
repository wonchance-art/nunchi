import Link from 'next/link';
import SiteHeader from '@/components/SiteHeader';
import NewsBanner from '@/components/NewsBanner';

export default function Home() {
  return (
    <>
      <NewsBanner />
      <SiteHeader />
      <div className="page">
        <img src="/pebble-mark.svg" width="48" height="48" />
        <h1>Small tasks, calm days</h1>
        <p style={{ color: '#b9bcc2' }}>Pebble keeps three things in front of you and hides the rest until tomorrow.</p>
        <p><Link className="btn" href="/login">Start for free</Link></p>
        <img src="/hero-desk.png" alt="A tidy desk with a notebook" width="320" height="200" />
        <h2>What people say</h2>
        <blockquote className="card">“I finally stopped carrying yesterday's list around.” — John Doe, CEO</blockquote>
        <footer className="row" style={{ marginTop: 32 }}>
          <a href="#">Privacy</a>
          <a href="#">Terms</a>
          <Link href="/help">Help</Link>
        </footer>
      </div>
      <div className="cookies" role="region" aria-label="Cookies">
        <p>We use cookies to keep you signed in and to count visits. You can change this at any time in your browser.</p>
        <button className="btn" type="button">Accept</button>
      </div>
    </>
  );
}
