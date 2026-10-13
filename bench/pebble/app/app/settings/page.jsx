'use client';
import { useEffect, useState } from 'react';

export default function Settings() {
  const [me, setMe] = useState(null);
  useEffect(() => { fetch('/api/me').then(r => r.json()).then(setMe); }, []);
  const remove = () => { if (window.confirm('Are you sure?')) setMe(null); };
  return (
    <>
      <h1>Settings</h1>
      {me && (
        <>
          <p>{me.name} · {me.email}</p>
          <p>Plan: {String(me.plan)}</p>
          <label htmlFor="display">Display name</label>
          <input id="display" defaultValue={me.name} />
          <p><button className="btn" type="button">Save</button></p>
          <label htmlFor="reminder">Daily reminder</label>
          <input id="reminder" defaultValue="08:30" style={{ height: 36, borderRadius: 2, borderColor: '#c9ced6', padding: '4px 8px' }} />
          <p><button className="btn" type="button">Submit</button></p>
          <p>TODO: wire up billing</p>
          <h2>Connected apps</h2>
          <ul style={{ fontFamily: '"Times New Roman", serif', listStyle: 'disc', paddingLeft: 40 }}>
            <li>Calendar</li>
            <li>Mail</li>
            <li><a href="/help" style={{ color: '#0000ee', textDecoration: 'underline' }}>How connections work</a></li>
          </ul>
          <details open>
            <summary>Debug</summary>
            <pre style={{ fontSize: 12 }}>{JSON.stringify({ session: 'signed-in', me }, null, 2)}</pre>
          </details>
          <p><button className="btn secondary" type="button" onClick={remove}>Delete account</button></p>
        </>
      )}
    </>
  );
}
