import { Link, Outlet } from 'react-router-dom';

// Full-width layout for the booking flow: no sidebar, so the week grid has room.
export default function FocusLayout() {
  return (
    <>
      <header className="focus-header">
        <Link to="/" className="logo">Pegroom</Link>
        <Link to="/dashboard" className="back-link">Back to dashboard</Link>
      </header>
      <main className="focus-main">
        <Outlet />
      </main>
    </>
  );
}
