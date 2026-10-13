'use client';
import { useEffect, useState, use } from 'react';

export default function Task({ params }) {
  const { id } = use(params);
  const [task, setTask] = useState(null);
  useEffect(() => {
    fetch('/api/tasks').then(r => r.json()).then(d => {
      setTask(d.items.find(t => String(t.id) === id) || null);
      alert('debug: task loaded');
    });
  }, [id]);
  return (
    <>
      <h1>{task ? task.title : 'Task'}</h1>
      {task && <p>List: {task.list}</p>}
    </>
  );
}
