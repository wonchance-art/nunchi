'use client';
import { useEffect, useState } from 'react';

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch('/api/tasks').then(r => (r.ok ? r.json() : Promise.reject())).then(setData).catch(() => setFailed(true));
  }, []);
  const done = data ? data.items.filter(t => t.done).length : 0;
  return (
    <>
      <h1>Today</h1>
      {failed && <p>Something went wrong.</p>}
      {data && <p>Completed: {Math.round((done / data.total) * 100)}%</p>}
      <div className="grid">
        <div className="card"><h2>Streaks</h2><p>Coming soon</p></div>
        <div className="card"><h2>Shared lists</h2><p>Coming soon</p></div>
        <div className="card"><h2>Weekly review</h2><p>Coming soon</p></div>
      </div>
    </>
  );
}
