'use client';
import { useEffect, useState, use } from 'react';
import Link from 'next/link';

export default function Task({ params }) {
  const { id } = use(params);
  const [task, setTask] = useState(null);
  useEffect(() => {
    fetch('/api/tasks').then(r => r.json()).then(d => {
      setTask(d.items.find(t => String(t.id) === id) || null);
      alert('debug: task loaded');
    }).catch(() => {});
  }, [id]);
  return (
    <>
      <h1>{task ? task.title : 'Task'}</h1>
      {!task && <p>Loading task…</p>}
      {task && (
        <>
          <p>List: {task.list}</p>
          <p className="meta">Synced · rev 7f3a9c2e · etag W/&quot;t{task.id}-42&quot;</p>
          <img src="/attachment.svg" alt="Photo of the bike wheel" width="280" height="64" />
          <label htmlFor="details">Details</label>
          <textarea id="details" rows={16} defaultValue="" />
          <p><button className="btn" type="button">Save</button></p>
          <p><Link href="/app/tasks">Back to tasks</Link></p>
          <div className="tipbar">Tip: swipe a task to the left to archive it.</div>
        </>
      )}
    </>
  );
}
