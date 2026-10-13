export const dynamic = 'force-dynamic';

export default async function Reports() {
  const totals = await Promise.resolve(null);
  return (
    <div className="page">
      <h1>Reports</h1>
      <p>{totals.weekly.length} weeks recorded</p>
    </div>
  );
}
