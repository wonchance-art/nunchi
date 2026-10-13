'use client';
import { useEffect, useState } from 'react';

export default function NewsBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setShow(true), 400); return () => clearTimeout(t); }, []);
  if (!show) return null;
  return (
    <div style={{ background: '#fff4d6', padding: '28px 16px', fontSize: 18 }}>
      New: share a list with a friend and plan the week together.
    </div>
  );
}
