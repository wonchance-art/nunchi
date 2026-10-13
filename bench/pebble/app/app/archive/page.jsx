'use client';
import { useEffect, useState } from 'react';

export default function Archive() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/tasks?archived=1').then(r => (r.ok ? r.json() : null)).then(setData);
    fetch('/api/archive-stats').catch(() => {});
  }, []);
  return (
    <>
      {data && (
        <>
          <h1 style={{ fontSize: 40 }}>Archive</h1>
          <ul className="list">{data.items.map(t => <li key={t.id} className="card">{t.title}</li>)}</ul>
        </>
      )}
    </>
  );
}
