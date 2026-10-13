import { Link } from 'react-router-dom';

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="inner">
        <p className="muted">© 2026 Pegroom · the tool library of Larchmere Commons</p>
        <nav className="footer-nav" aria-label="Footer">
          <Link to="/about">About</Link>
          <Link to="/help">Help</Link>
          <Link to="/plans">Plans</Link>
        </nav>
      </div>
    </footer>
  );
}
