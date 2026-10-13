import { useEffect, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// Loads JSON for a screen. A 401 sends the member to sign in and back here afterwards.
export function useJson(url) {
  const navigate = useNavigate();
  const location = useLocation();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ status: 'loading', data: null });
  useEffect(() => {
    let live = true;
    setState({ status: 'loading', data: null });
    fetch(url, { headers: { accept: 'application/json' } })
      .then(async res => {
        if (res.status === 401) {
          navigate(`/sign-in?next=${encodeURIComponent(location.pathname)}`, { replace: true });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (live) setState({ status: 'ready', data });
      })
      .catch(() => { if (live) setState({ status: 'error', data: null }); });
    return () => { live = false; };
  }, [url, attempt]);
  const retry = useCallback(() => setAttempt(a => a + 1), []);
  return { ...state, retry };
}

export function isSignedIn() {
  return typeof document !== 'undefined' && /(?:^|;\s*)pegroom_sid=/.test(document.cookie);
}
