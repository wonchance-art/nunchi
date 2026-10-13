import { Link, NavLink } from 'react-router-dom';
import { isSignedIn } from '../api.js';

export default function SiteHeader() {
  return (
    <header className="site-header">
      <div className="inner">
        <Link to="/" className="logo">Pegroom</Link>
        <nav className="site-nav" aria-label="Main">
          <NavLink to="/tools">Tools</NavLink>
          <NavLink to="/plans">Plans</NavLink>
          <NavLink to="/about">About</NavLink>
          <NavLink to="/help">Help</NavLink>
        </nav>
        <div className="header-end">
          {isSignedIn()
            ? <Link className="btn btn-sm" to="/dashboard">Dashboard</Link>
            : <Link className="btn btn-sm" to="/sign-in">Sign in</Link>}
        </div>
      </div>
    </header>
  );
}
