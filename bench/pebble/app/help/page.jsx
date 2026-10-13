import SiteHeader from '@/components/SiteHeader';

export default function Help() {
  return (
    <>
      <SiteHeader />
      <div className="page">
        <h1>Help</h1>
        <h2>How do I add a task?</h2>
        <p>Open Tasks and type in the box at the top. Press Enter to save it.</p>
        <h2>Can I share a list?</h2>
        <p>Yes, on the Garden plan you can share up to five lists with friends.</p>
      </div>
    </>
  );
}
