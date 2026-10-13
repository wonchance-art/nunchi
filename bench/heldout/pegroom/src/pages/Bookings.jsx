import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatDay } from '../format.js';

const SCROLL_KEY = 'pegroom:bookings-scroll';
const FILTERS = [['all', 'All benches'], ['woodwork', 'Woodwork'], ['metalwork', 'Metalwork'], ['sewing', 'Sewing table']];
const LABEL = { confirmed: 'Confirmed', pending: 'Pending' };

export default function Bookings() {
  const navigate = useNavigate();
  const [bookings, setBookings] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    fetch('/api/bookings')
      .then(res => {
        if (res.status === 401) { navigate('/sign-in?next=/bookings', { replace: true }); return null; }
        if (!res.ok) throw new Error(`bookings ${res.status}`);
        return res.json();
      })
      .then(d => d && setBookings(d.bookings))
      .catch(() => setBookings([]));
    return () => sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ y: window.scrollY }));
  }, []);

  // put the list back where the member left it
  useEffect(() => {
    if (!bookings || !bookings.length) return;
    const t = setTimeout(() => {
      const saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY));
      window.scrollTo(0, saved.y);
    }, 0);
    return () => clearTimeout(t);
  }, [bookings]);

  const release = id => fetch(`/api/bookings/${id}`, { method: 'DELETE' })
    .then(() => setBookings(list => list.filter(b => b.id !== id)));

  const shown = (bookings || []).filter(b => filter === 'all' || b.bench.toLowerCase().includes(filter));

  return (
    <>
      <div className="install" role="region" aria-label="Get the app">
        <p>Get the Pegroom app for faster check-in at the front desk.</p>
        <button type="button" className="btn btn-sm btn-light">Install</button>
        <button type="button" className="btn btn-sm btn-ghost-light">Not now</button>
      </div>
      <h1>Bookings</h1>
      <div className="toolbar">
        <select className="input" value={filter} onChange={e => setFilter(e.target.value)}>
          {FILTERS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
        <Link className="btn" to="/book">Book a bench</Link>
      </div>
      {bookings === null ? (
        <p>Loading your bookings…</p>
      ) : bookings.length === 0 ? (
        <div className="state">
          <p>No bookings yet.</p>
          <p><Link to="/book">Book a bench</Link> to reserve your first slot.</p>
        </div>
      ) : (
        <>
          <ul className="rows">
            {shown.map(b => (
              <li className="row" key={b.id}>
                <div>
                  <Link className="row-title" to={`/bookings/${b.id}`}>{b.bench}</Link>
                  <p className="muted">{formatDay(b.date)} · {b.start}–{b.end}</p>
                </div>
                <span className={`pill pill-${b.status}`}>{LABEL[b.status]}</span>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => release(b.id)}>Release slot</button>
              </li>
            ))}
          </ul>
          <nav className="pager" aria-label="Pages">
            {[1, 2, 3].map(n => <Link key={n} to={`/bookings?page=${n}`} aria-current={n === 1 ? 'page' : undefined}>{n}</Link>)}
          </nav>
        </>
      )}
    </>
  );
}
