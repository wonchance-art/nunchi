import { useJson } from '../api.js';
import { formatDate } from '../format.js';
import { createPayments } from '../payments.js';

const payments = createPayments(import.meta.env.NEXT_PUBLIC_PAYMENT_KEY);

export default function Billing() {
  const { status, data, retry } = useJson('/api/billing');
  return (
    <>
      <h1>Billing and payments</h1>
      {status === 'loading' && <p>Loading billing…</p>}
      {status === 'error' && (
        <div className="state">
          <p>We couldn't load your billing details. Check your connection and try again.</p>
          <button type="button" className="btn btn-secondary" onClick={retry}>Try again</button>
        </div>
      )}
      {status === 'ready' && (
        <section className="card">
          <h2>{data.billing.plan} plan</h2>
          <p>Paid by {data.billing.card}. Next payment on {formatDate(data.billing.next)}.</p>
          {payments.ready && <button type="button" className="btn" onClick={() => payments.checkout('workshop')}>Change plan</button>}
        </section>
      )}
    </>
  );
}
