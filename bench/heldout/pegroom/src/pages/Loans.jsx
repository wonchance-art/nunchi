import { useEffect, useState } from 'react';
import { daysUntil, formatDay } from '../format.js';

export default function Loans() {
  const [loans, setLoans] = useState(null);

  useEffect(() => {
    fetch('/api/loans')
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`loans ${res.status}`))))
      .then(d => setLoans(d.loans))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!loans) return;
    const late = loans.filter(l => daysUntil(l.due) < 0);
    if (late.length) window.alert(`Reminder: ${late[0].tool} was due back on ${formatDay(late[0].due)}. Please return it to the front desk.`);
  }, [loans]);

  const renew = id => fetch(`/api/loans/${id}/renew`, { method: 'POST' });

  if (!loans) return null;

  return (
    <>
      <h1 className="loans-title">My loans</h1>
      {loans.length === 0 ? (
        <p>You have no tools on loan.</p>
      ) : (
        <>
          <p>You have {loans.length} kit items out. Kit is due back by closing time on the due date.</p>
          <ul className="rows">
            {loans.map(l => (
              <li className="row" key={l.id}>
                <span className="loan-name">{l.tool}</span>
                <span className="muted">Due {formatDay(l.due)}{daysUntil(l.due) < 0 ? ' · overdue' : ''} · renewed {l.renewals} of 2 times</span>
                <button type="button" className="icon-btn" onClick={() => renew(l.id)}>
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" /></svg>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
