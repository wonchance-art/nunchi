import { Link } from 'react-router-dom';
import SiteHeader from '../layouts/SiteHeader.jsx';

const WORKSHOPS = [
  { id: 'w1', title: 'Sharpening chisels and planes', when: 'Thursdays · 19:00–21:00 · 6 places', text: 'Get a mirror edge with water stones, and learn how to keep it between projects.' },
  { id: 'w2', title: 'First steps on the lathe', when: 'Saturdays · 10:00–13:00 · 4 places', text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis.' },
  { id: 'w3', title: 'Fixing a wobbly chair', when: 'Sundays · 14:00–16:00 · 8 places', text: 'Bring a chair that rocks. We will re-glue the joints and level the legs together.' },
];

// Workshops keeps its own page shell: it started as a stand-alone sign-up page for the spring term.
export default function Workshops() {
  return (
    <>
      <SiteHeader />
      <main className="site-main">
        <h1>Workshops this term</h1>
        <p className="lead">Short classes run by our stewards. Places are limited, so sign up at the front desk.</p>
        <div className="grid">
          {WORKSHOPS.map(w => (
            <article className="card" key={w.id}>
              <h2>{w.title}</h2>
              <p className="muted">{w.when}</p>
              <p>{w.text}</p>
            </article>
          ))}
        </div>
      </main>
      <footer className="site-footer">
        <div className="inner">
          <p className="muted">© 2024 Pegroom · the tool library of Larchmere Commons</p>
          <nav className="footer-nav" aria-label="Footer">
            <Link to="/about">About</Link>
            <Link to="/plans">Plans</Link>
          </nav>
        </div>
      </footer>
    </>
  );
}
