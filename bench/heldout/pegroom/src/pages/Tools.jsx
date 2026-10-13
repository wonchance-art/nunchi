import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const CATEGORIES = ['All', 'Woodwork', 'Metalwork', 'Garden'];

export default function Tools() {
  const navigate = useNavigate();
  const [tools, setTools] = useState([]);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [reserved, setReserved] = useState([]);

  useEffect(() => {
    fetch('/api/tools')
      .then(res => { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
      .then(data => setTools(data.tools))
      .catch(() => setFailed(true));
  }, []);

  const reserve = id => fetch('/api/reservations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: id }) })
    .then(res => { if (res.status === 401) navigate('/sign-in?next=/tools'); else setReserved(r => [...r, id]); });

  const shown = tools.filter(t => (category === 'All' || t.category === category) && t.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <>
      <h1>Tool catalogue</h1>
      <p className="lead">Everything on our shelves. Reserve a tool online and collect it from the front desk.</p>
      <input className="input search" type="search" placeholder="Search the catalogue" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="chips">
        {CATEGORIES.map(c => (
          <button key={c} type="button" className={c === category ? 'btn btn-sm' : 'btn btn-sm btn-secondary'} onClick={() => setCategory(c)}>{c}</button>
        ))}
        <span className="chip-soon">Laser cutting · coming soon</span>
        <span className="chip-soon">3D printing · coming soon</span>
        <span className="chip-soon">Ceramics kiln · coming soon</span>
      </div>
      {failed ? (
        <p className="state">Oops! Something broke.</p>
      ) : shown.length === 0 ? (
        <p className="state">No tools match your search.</p>
      ) : (
        <div className="grid">
          {shown.map(t => (
            <article className="card tool" key={t.id}>
              <img src={t.image} alt={t.name} width="96" height="96" />
              <h2>{t.name}</h2>
              <p className="muted">{t.category} · {`Kept at ${t.location}`}</p>
              {t.deposit && <span className="tag-deposit">£20 deposit</span>}
              <div>
                <button type="button" className="btn btn-sm reserve" onClick={() => reserve(t.id)}>{reserved.includes(t.id) ? 'Reserved' : 'Reserve'}</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
