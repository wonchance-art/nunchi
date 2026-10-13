import { createBrowserRouter } from 'react-router-dom';
import SiteLayout from './layouts/SiteLayout.jsx';
import AppLayout from './layouts/AppLayout.jsx';
import FocusLayout from './layouts/FocusLayout.jsx';
import Landing from './pages/Landing.jsx';
import About from './pages/About.jsx';
import Help from './pages/Help.jsx';
import Plans from './pages/Plans.jsx';
import Tools from './pages/Tools.jsx';
import SignIn from './pages/SignIn.jsx';
import Workshops from './pages/Workshops.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Bookings from './pages/Bookings.jsx';
import BookingDetail from './pages/BookingDetail.jsx';
import Book from './pages/Book.jsx';
import Loans from './pages/Loans.jsx';
import History from './pages/History.jsx';
import Settings from './pages/Settings.jsx';
import Billing from './pages/Billing.jsx';
import NotFound from './pages/NotFound.jsx';

export const router = createBrowserRouter([
  {
    element: <SiteLayout />,
    children: [
      { path: '/', element: <Landing /> },
      { path: '/about', element: <About /> },
      { path: '/help', element: <Help /> },
      { path: '/plans', element: <Plans /> },
      { path: '/tools', element: <Tools /> },
      { path: '/sign-in', element: <SignIn /> },
      { path: '*', element: <NotFound /> },
    ],
  },
  { path: '/workshops', element: <Workshops /> },
  {
    element: <AppLayout />,
    children: [
      { path: '/dashboard', element: <Dashboard /> },
      { path: '/bookings', element: <Bookings /> },
      { path: '/bookings/:id', element: <BookingDetail /> },
      { path: '/loans', element: <Loans /> },
      { path: '/history', element: <History /> },
      { path: '/settings', element: <Settings /> },
      { path: '/account/billing', element: <Billing /> },
    ],
  },
  {
    element: <FocusLayout />,
    children: [{ path: '/book', element: <Book /> }],
  },
]);
