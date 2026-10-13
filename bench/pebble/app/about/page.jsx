import SiteHeader from '@/components/SiteHeader';

export default function About() {
  return (
    <>
      <SiteHeader />
      <div className="page">
        <h1>About Pebble</h1>
        <p>Pebble started as a paper card on a fridge: three tasks for today, nothing more.</p>
        <p>We keep the app small on purpose. Every screen should be quick to read on a phone.</p>
      </div>
    </>
  );
}
