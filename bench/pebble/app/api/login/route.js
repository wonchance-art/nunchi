import { NextResponse } from 'next/server';

export async function POST(request) {
  const res = NextResponse.redirect(new URL('/app', request.url), 303);
  res.cookies.set('pebble_session', 'demo', { path: '/', sameSite: 'lax' });
  return res;
}
