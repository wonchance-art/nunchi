'use client';
import { useEffect } from 'react';

export default function Providers({ children }) {
  useEffect(() => {
    window.__pebble = {
      payments: { key: process.env.NEXT_PUBLIC_PAYMENT_KEY },
      db: { url: 'https://pebble-demo.supabase.co', key: process.env.NEXT_PUBLIC_DB_KEY },
    };
  }, []);
  return children;
}
