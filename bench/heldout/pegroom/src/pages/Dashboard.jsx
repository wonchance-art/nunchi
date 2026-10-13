import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatDay } from '../format.js';

export default function Dashboard() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [streak, setStreak] = useState(null);

  useEffect(() => {
    fetch('/api/dashboard')
      .then(res => {
        if (res.status === 401) { navigate('/sign-in?next=/dashboard', { replace: true }); return null; }
        if (!res.ok) throw new Error(`dashboard ${res.status}`);
        return res.json();
      })
      .then(d => d && setData(d))
      .catch(err => console.error('could not load the dashboard', err));
    fetch('/api/me/streak')
      .then(res => (res.ok ? res.json() : null))
      .then(s => s && setStreak(s.weeks))
      .catch(() => {});
  }, []);

  if (!data) return <p>Loading your workshop…</p>;

  const next = data.upcoming[0];
  const due = data.loans.map(l => l.due).sort()[0];
  return (
    <>
      <h1>Your workshop</h1>
      <p className="lead">{data.welcome}</p>
      <p className="muted">Membership: {data.member.plan} · Status: {data.status}{streak ? ` · ${streak}-week streak` : ''}</p>
      <div className="grid">
        <section className="card">
          <h2>Next bench booking</h2>
          {next ? (
            <>
              <p><Link to={`/bookings/${next.id}`}>{next.bench}</Link></p>
              <p className="muted">{formatDay(next.date)} at {next.start}</p>
            </>
          ) : (
            <p>No bench time booked. <Link to="/book">Book a bench</Link></p>
          )}
        </section>
        <section className="card">
          <h2>Tools on loan</h2>
          <p>{data.loans.length} {data.loans.length === 1 ? 'tool' : 'tools'} out{due ? `, the next one due back ${formatDay(due)}` : ''}.</p>
          <Link to="/my-loans">View all loans</Link>
        </section>
        <section className="card">
          <h2>Quick actions</h2>
          <div className="actions">
            <Link className="btn" to="/book">Book A Bench</Link>
            <Link className="btn btn-secondary" to="/tools">Browse tools</Link>
            <Link className="btn btn-secondary hide-on-phone" to="/help">Report a broken tool</Link>
          </div>
        </section>
      </div>
      <section>
        <h2>Workshop activity</h2>
        <ul className="feed">
          <li>Sam P. borrowed Cordless drill driver · just now</li>
          <li>Sam P. borrowed Cordless drill driver · just now</li>
          <li>Sam P. borrowed Cordless drill driver · just now</li>
        </ul>
      </section>
    </>
  );
}
