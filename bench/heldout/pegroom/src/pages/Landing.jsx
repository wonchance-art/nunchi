import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

export default function Landing() {
  const [notices, setNotices] = useState([]);
  useEffect(() => {
    let timer;
    fetch('/api/announcements')
      .then(res => (res.ok ? res.json() : { announcements: [] }))
      .then(data => {
        // notices wait until the hero has painted, so they never hold up the first view
        timer = setTimeout(() => setNotices(data.announcements || []), 350);
      })
      .catch(() => {});
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      {notices.map(n => (
        <section key={n.id} className="closure" aria-label="Notice">
          <h2>{n.title}</h2>
          <p>{n.body}</p>
          <Link to={n.link}>How pick-ups work that week</Link>
        </section>
      ))}
      <h1>Borrow it, don't buy it</h1>
      <section className="hero">
        <p className="hero-lead">Drills, sanders, ladders and garden tools, plus four shared workbenches, five minutes from Larchmere station.</p>
        <div className="hero-actions">
          <Link className="btn" to="/plans">Become a member</Link>
          <Link className="btn btn-secondary" to="/tools">Browse tools</Link>
        </div>
      </section>
      <section className="how">
        <img src="/img/how-it-works.svg" width="320" height="180" />
        <div>
          <h2>How it works</h2>
          <ol className="steps">
            <li><h3>Join</h3><p>Pick a plan and come in for a short induction with a steward.</p></li>
            <li><h3>Reserve</h3><p>Reserve a tool online or book an hour at a bench.</p></li>
            <li><h3>Collect and return</h3><p>Pick it up at the front desk and bring it back within a week.</p></li>
          </ol>
        </div>
      </section>
      <section>
        <h2>Opening hours</h2>
        <p>Tuesday to Sunday, 10:00–20:00, with late opening until 22:00 on Thursdays. <a href="#">See the full timetable</a></p>
      </section>
    </>
  );
}
