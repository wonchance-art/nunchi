export const dynamic = 'force-dynamic';

const TASKS = [
  { id: 1, title: 'Water the fern on the windowsill', list: 'Home', done: true },
  { id: 2, title: 'Return the library book about lighthouses', list: 'Errands and small trips', done: false },
  { id: 3, title: 'Call the bike shop about the brake pads', list: 'Errands', done: false },
];
const ARCHIVED = [{ id: 9, title: 'Plan the picnic', list: 'Weekend', done: true }];

export async function GET(request) {
  const archived = new URL(request.url).searchParams.get('archived');
  const items = archived ? ARCHIVED : TASKS;
  return Response.json({ items, total: items.length });
}
