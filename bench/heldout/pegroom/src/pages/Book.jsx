import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const DAYS = ['Mon 19', 'Tue 20', 'Wed 21', 'Thu 22', 'Fri 23', 'Sat 24', 'Sun 25'];
const TIMES = ['10:00', '14:00', '18:00', '20:00'];
// keeps the form usable when the bench list cannot be fetched
const FALLBACK_BENCHES = [
  { id: 'bench-a', name: 'Bench A · woodwork' },
  { id: 'bench-b', name: 'Bench B · woodwork' },
  { id: 'bench-c', name: 'Bench C · metalwork' },
  { id: 'sewing', name: 'Sewing table' },
];

export default function Book() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [bench, setBench] = useState('');
  const [picked, setPicked] = useState(null);
  const [project, setProject] = useState('');
  const [details, setDetails] = useState('');

  const load = () => fetch('/api/benches')
    .then(res => {
      if (res.status === 401) { navigate('/sign-in?next=/book', { replace: true }); return null; }
      if (!res.ok) throw new Error(`benches ${res.status}`);
      return res.json();
    })
    .then(d => { if (d) { setData(d); setBench(d.benches[0]?.id || ''); } })
    .catch(() => { setData({ benches: FALLBACK_BENCHES, slots: null }); setBench(FALLBACK_BENCHES[0].id); });

  useEffect(() => { load(); }, []);

  if (!data) return <p>Loading benches…</p>;

  const isFree = (day, time) => !!data.slots?.find(s => s.day === day && s.time === time && s.free);
  const benchName = data.benches.find(b => b.id === bench)?.name || 'No bench chosen yet';
  const reset = () => { setPicked(null); setProject(''); setDetails(''); load(); };
  const submit = () => fetch('/api/bookings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bench, slot: picked, project, details }) })
    .then(() => navigate('/bookings'));

  return (
    <>
      <h1>Book a bench</h1>
      <p>The member must select a bench and a free slot. Bookings are subject to steward approval, and the member is responsible for leaving the bench clean.</p>
      <div className="book-layout">
        <form className="book-form" onSubmit={e => { e.preventDefault(); submit(); }}>
          <div className="field">
            <label htmlFor="bench">Bench</label>
            <select id="bench" className="input" value={bench} onChange={e => setBench(e.target.value)}>
              {data.benches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <fieldset className="field">
            <legend>Week of 19 January</legend>
            {data.slots && data.slots.length === 0 ? (
              <p>No slots published for this week yet.</p>
            ) : (
              <div className="week">
                <span />
                {DAYS.map(d => <span className="day" key={d}>{d}</span>)}
                {TIMES.map(t => (
                  <Row key={t} time={t} isFree={isFree} picked={picked} onPick={setPicked} />
                ))}
              </div>
            )}
          </fieldset>
          <div className="field">
            <label htmlFor="project">Project name</label>
            <input id="project" className="input" value={project} onChange={e => setProject(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="details">Project description</label>
            <textarea id="details" className="input" rows={6} value={details} onChange={e => setDetails(e.target.value)} />
          </div>
          <p className="debug">debug: benches={data.benches.length} slots={data.slots ? data.slots.length : 0} tz=UTC build=dev</p>
          <button type="button" className="btn btn-sm btn-secondary" onClick={reset}>Reset mock data</button>
        </form>
        <aside className="summary card">
          <h2>Your booking</h2>
          <p>{benchName}</p>
          <p className="muted">{picked ? `${picked.day} at ${picked.time}` : 'No slot chosen yet'}</p>
          <button type="button" className="confirm" onClick={submit}>Confirm booking</button>
        </aside>
      </div>
    </>
  );
}

function Row({ time, isFree, picked, onPick }) {
  return (
    <>
      <span className="time">{time}</span>
      {DAYS.map(day => (isFree(day, time)
        ? <button type="button" key={day} className={picked && picked.day === day && picked.time === time ? 'slot picked' : 'slot'} onClick={() => onPick({ day, time })}>{time}</button>
        : <span key={day} className="slot-full">Full</span>))}
    </>
  );
}
