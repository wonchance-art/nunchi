'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function Tasks() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    fetch('/api/tasks').then(async r => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.message);
      setData(body);
    }).catch(e => setError(e.message));
  }, []);
  const clearAll = () => setData({ items: [], total: 0 });
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Tasks</h1>
        <button className="btn secondary desktop-only" type="button">Export</button>
      </div>
      {error && <p>{error}</p>}
      {data && data.items.length === 0 && <p>No tasks yet. Add your first one.</p>}
      {data && (
        <ul className="list">
          {data.items.map(t => (
            <li key={t.id} className="card row">
              <button type="button" aria-label={t.done ? 'Mark as not done' : 'Mark as done'} style={{ width: 18, height: 18, padding: 0, border: '1px solid #555b66', borderRadius: 4, background: t.done ? '#2f5d50' : '#fff' }} />
              <Link href={`/app/tasks/${t.id}`} style={{ flex: 1 }}>{t.title}</Link>
              <span style={{ width: 96, overflow: 'hidden', whiteSpace: 'nowrap', fontSize: 13, color: '#555b66' }}>{t.list}</span>
              <button type="button" style={{ width: 44, height: 44, border: 0, background: 'transparent' }}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M6 4V2h4v2M5 4l1 10h4l1-10" fill="none" stroke="#555b66" strokeWidth="1.5"/></svg></button>
            </li>
          ))}
        </ul>
      )}
      {data && data.items.length > 0 && <p><button className="btn secondary" type="button" onClick={clearAll}>Clear all tasks</button></p>}
    </>
  );
}
