import Link from 'next/link';

export default function Pricing() {
  return (
    <>
      <header className="top">
        <Link className="brand" href="/">Pebble</Link>
        <Link href="/about">About</Link>
        <Link className="btn" href="/login">Sign in</Link>
      </header>
      <div className="page">
        <h1>Pricing</h1>
        <table style={{ minWidth: 720, borderCollapse: 'collapse' }}>
          <thead><tr><th align="left">Plan</th><th align="left">Lists</th><th align="left">Shared lists</th><th align="left">Reminders</th><th align="left">Price</th></tr></thead>
          <tbody>
            <tr><td>Pocket</td><td>3</td><td>—</td><td>Daily</td><td>Free</td></tr>
            <tr><td>Garden</td><td>Unlimited</td><td>5</td><td>Any time</td><td>$4 / month</td></tr>
          </tbody>
        </table>
        <p><button style={{ minHeight: 52, padding: '0 28px', borderRadius: 24, border: 0, background: '#2f5d50', color: '#fff', fontWeight: 800, fontSize: 18 }}>Choose Garden</button></p>
        <p style={{ fontSize: 14 }}>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Questions? Write to support@example.com.</p>
      </div>
    </>
  );
}
