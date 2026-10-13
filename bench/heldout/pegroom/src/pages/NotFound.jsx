import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p>We couldn't find that page. It may have moved.</p>
      <div className="actions">
        <Link className="btn" to="/">Go to the home page</Link>
      </div>
    </>
  );
}
