import { Link } from 'react-router-dom';
import { useJson } from '../api.js';
import { formatDate } from '../format.js';

export default function History() {
  const { status, data, retry } = useJson('/api/history');
  return (
    <>
      <h1>Loan history</h1>
      <p className="lead">Tools you have borrowed and returned.</p>
      {status === 'loading' && <p>Loading your loan history…</p>}
      {status === 'error' && (
        <div className="state">
          <p>We couldn't load your loan history. Check your connection and try again.</p>
          <button type="button" className="btn btn-secondary" onClick={retry}>Try again</button>
        </div>
      )}
      {status === 'ready' && data.loans.length === 0 && (
        <div className="state">
          <p>No past loans yet. Tools you return will be listed here.</p>
          <Link className="btn btn-secondary" to="/tools">Browse tools</Link>
        </div>
      )}
      {status === 'ready' && data.loans.length > 0 && (
        <ul className="rows">
          {data.loans.map(l => (
            <li className="row" key={l.id}>
              <span>{l.tool}</span>
              <span className="muted">Borrowed {formatDate(l.borrowed)} · returned {formatDate(l.returned)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
