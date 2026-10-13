'use client';
import { useEffect, useState } from 'react';

export default function Notes() {
  const [notes, setNotes] = useState(null);
  useEffect(() => {
    fetch('/api/notes').then(r => (r.ok ? r.json() : { items: [] })).then(d => setNotes(d.items));
    setTimeout(() => { window.__pebbleMetrics.flush(); }, 0);
  }, []);
  return (
    <>
      <h1 style={{ color: '#5a5aff' }}>Notes</h1>
      <p>Your memos, newest first.</p>
      {notes && notes.length === 0 && <p>No notes yet.</p>}
      {notes && notes.length > 0 && <ul className="list">{notes.map(n => <li key={n.id} className="card">{n.text}</li>)}</ul>}
    </>
  );
}
