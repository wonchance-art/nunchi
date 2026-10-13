'use client';
import { useEffect, useState } from 'react';

export default function Archive() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/tasks?archived=1').then(r => (r.ok ? r.json() : null)).then(setData);
    fetch('/api/archive-stats').catch(() => {});
  }, []);
  const emptyArchive = () => setData({ items: [], total: 0 });
  return (
    <>
      {data && (
        <>
          <h1 style={{ fontSize: 40 }}>Archive</h1>
          <ul className="list">{data.items.map(t => <li key={t.id} className="card" style={{ position: 'relative' }}><span className="stamp">Archived</span>{t.title}</li>)}</ul>
          {data.items.length > 0 && (
            <p className="row">
              <button className="btn" type="button" style={{ background: '#2f5e52', borderColor: '#2f5e52' }}>Restore all</button>
              <button className="btn secondary" type="button" onClick={emptyArchive}>Empty archive</button>
            </p>
          )}
        </>
      )}
    </>
  );
}
