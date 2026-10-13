import { useEffect, useState } from 'react';

export default function OfflineNotice() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  if (online) return null;
  return (
    <div className="notice" role="status">
      You're offline. What's on this page may be out of date, and changes can't be saved until you're back online.
    </div>
  );
}
