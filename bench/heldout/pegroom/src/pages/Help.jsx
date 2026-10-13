import { Link } from 'react-router-dom';

export default function Help() {
  return (
    <>
      <h1>Help</h1>
      <p className="lead">Answers to the questions we hear most at the front desk.</p>
      <h2>Borrowing tools</h2>
      <h3>How long can I keep a tool?</h3>
      <p>Seven days. You can renew a loan twice from the Loans page, as long as nobody else has reserved the tool.</p>
      <h3>What if a tool breaks while I have it?</h3>
      <p>Bring it back and tell a steward. Wear and tear is expected, and you only pay for a repair if the tool was misused.</p>
      <h2>Booking a bench</h2>
      <h3>How do I book?</h3>
      <p>Sign in and choose Book a bench. Pick a bench and a free slot, then confirm your booking.</p>
      <h3>Can I cancel?</h3>
      <p>Yes, up to 24 hours before the slot starts, from the booking's own page.</p>
      <h2>Still stuck?</h2>
      <p>Ask a steward at the front desk during opening hours, Tuesday to Sunday, 10:00–20:00.</p>
      <div className="actions">
        <Link className="btn btn-secondary" to="/tools">Browse tools</Link>
      </div>
    </>
  );
}
