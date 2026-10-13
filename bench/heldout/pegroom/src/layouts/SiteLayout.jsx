import { Outlet } from 'react-router-dom';
import SiteHeader from './SiteHeader.jsx';
import SiteFooter from './SiteFooter.jsx';
import OfflineNotice from './OfflineNotice.jsx';

export default function SiteLayout() {
  return (
    <>
      <SiteHeader />
      <main className="site-main">
        <OfflineNotice />
        <Outlet />
      </main>
      <SiteFooter />
    </>
  );
}
