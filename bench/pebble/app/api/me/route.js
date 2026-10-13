export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ name: 'Mina Park', email: 'mina@pebble.test' });
}
