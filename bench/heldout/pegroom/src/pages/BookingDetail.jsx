import { Link, useNavigate, useParams } from 'react-router-dom';
import { useJson } from '../api.js';
import { formatDay } from '../format.js';

function calendarFile(b) {
  const stamp = (d, t) => `${d.replaceAll('-', '')}T${t.replace(':', '')}00`;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${b.id}@pegroom`, `DTSTART:${stamp(b.date, b.start)}`, `DTEND:${stamp(b.date, b.end)}`, `SUMMARY:${b.bench}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = `${b.id}.ics`;
  a.click();
}

export default function BookingDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { status, data, retry } = useJson(`/api/bookings/${id}`);

  if (status === 'loading') return <p>Loading booking…</p>;
  if (status === 'error') {
    return (
      <div className="state">
        <p>We couldn't load this booking. Check your connection and try again.</p>
        <div className="actions">
          <button type="button" className="btn btn-secondary" onClick={retry}>Try again</button>
          <Link className="btn btn-secondary" to="/bookings">Back to bookings</Link>
        </div>
      </div>
    );
  }

  const b = data.booking;
  const cancel = () => {
    if (!window.confirm('Proceed?')) return;
    fetch(`/api/bookings/${b.id}`, { method: 'DELETE' }).then(() => navigate('/bookings'));
  };

  return (
    <>
      <Link className="back" to="/bookings">Back to bookings</Link>
      <h1 className="booking-title">{b.bench}</h1>
      <p><span className="tag-status">{b.status}</span></p>
      <div className="detail">
        <div className="detail-main card">
          <dl className="facts">
            <dt>Date</dt><dd>{formatDay(b.date)}</dd>
            <dt>Time</dt><dd>{b.start}–{b.end}</dd>
            <dt>Duration</dt><dd>{b.durationMins / 60} h</dd>
            <dt>Steward on duty</dt><dd>{b.steward}</dd>
            <dt>Your project</dt><dd>{b.notes}</dd>
          </dl>
          <div className="actions">
            <button type="button" className="btn btn-secondary hide-on-phone" onClick={() => calendarFile(b)}>Add to calendar</button>
            <button type="button" className="btn btn-danger" onClick={cancel}>Cancel booking</button>
          </div>
          <p className="muted">You can cancel up to 24 hours before the slot starts.</p>
        </div>
        <aside className="bring card">
          <h2>What to bring</h2>
          {b.bring.length ? <ul>{b.bring.map(x => <li key={x}>{x}</li>)}</ul> : <p>Nothing to bring.</p>}
        </aside>
      </div>
    </>
  );
}
