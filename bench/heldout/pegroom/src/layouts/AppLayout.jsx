import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import OfflineNotice from './OfflineNotice.jsx';

export default function AppLayout() {
  const navigate = useNavigate();
  const signOut = () => fetch('/api/sign-out', { method: 'POST' }).finally(() => navigate('/'));
  return (
    <div className="app">
      <nav className="app-nav" aria-label="Your account">
        <Link to="/" className="logo">Pegroom</Link>
        <NavLink to="/dashboard">Dashboard</NavLink>
        <NavLink to="/bookings">Bookings</NavLink>
        <NavLink to="/book">Book a bench</NavLink>
        <NavLink to="/loans">Loans</NavLink>
        <NavLink to="/history">History</NavLink>
        <NavLink to="/settings">Settings</NavLink>
        <NavLink to="/help">Help</NavLink>
        <button type="button" onClick={signOut}>Sign out</button>
      </nav>
      <main className="app-main">
        <OfflineNotice />
        <Outlet />
      </main>
    </div>
  );
}
