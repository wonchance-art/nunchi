export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ items: [{ id: 1, text: 'Buy oat milk on the way home' }, { id: 2, text: 'Ideas for the garden bench' }], total: 2 });
}
