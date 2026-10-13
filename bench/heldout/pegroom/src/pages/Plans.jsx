import { Link } from 'react-router-dom';
import { useJson } from '../api.js';

export default function Plans() {
  const { status, data, retry } = useJson('/api/plans');
  return (
    <>
      <h1>Membership plans</h1>
      <p className="lead">Pay monthly and cancel any time. Every plan includes the whole tool catalogue.</p>
      {status === 'loading' && <p>Loading plans…</p>}
      {status === 'error' && (
        <div className="state">
          <p>We couldn't load the plans. Check your connection and try again.</p>
          <button type="button" className="btn btn-secondary" onClick={retry}>Try again</button>
        </div>
      )}
      {status === 'ready' && data.plans.length === 0 && (
        <p className="state">No plans are open for sign-up right now. Ask a steward at the front desk.</p>
      )}
      {status === 'ready' && data.plans.length > 0 && (
        <>
          <div className="grid">
            {data.plans.map(p => (
              <article className="card plan" key={p.id}>
                {p.popular && <span className="badge-popular">Most popular</span>}
                <h2>{p.name}</h2>
                <p className="price">£{p.price}<span className="per"> a month</span></p>
                <ul>{p.features.map(f => <li key={f}>{f}</li>)}</ul>
                <Link className="btn" to={`/sign-in?plan=${p.id}`}>Choose {p.name}</Link>
              </article>
            ))}
          </div>
          <p className="fine">
            Prices include VAT. Late returns cost £1 a day after a two-day grace period. <Link to="/policies/late-returns">Read the late-return policy</Link>
          </p>
        </>
      )}
      <div className="join-bar">
        <p>New here? Your first induction is free.</p>
        <Link className="btn" to="/sign-in">Join now</Link>
      </div>
    </>
  );
}
