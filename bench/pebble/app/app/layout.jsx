import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Providers from '@/components/Providers';

export default async function AppLayout({ children }) {
  const jar = await cookies();
  if (!jar.get('pebble_session')) redirect('/login');
  return (
    <Providers>
      <div className="shell">
        <nav className="side" aria-label="Main">
          <Link href="/app" aria-label="Home">⌂</Link>
          <Link href="/app/tasks" aria-label="Tasks">☑</Link>
          <Link href="/app/notes" aria-label="Notes">✎</Link>
          <Link href="/app/archive"><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="4" width="16" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="2"/></svg></Link>
          <Link href="/app/settings" aria-label="Settings">⚙</Link>
        </nav>
        <main className="page">{children}</main>
      </div>
    </Providers>
  );
}
