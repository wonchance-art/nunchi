import { Link } from 'react-router-dom';

const STEWARDS = [
  { name: 'Tomasz Brannagh', role: 'Workshop steward, woodwork' },
  { name: 'Rhiannon Achebe', role: 'Workshop steward, metalwork' },
  { name: 'Ama Lindqvist', role: 'Front desk and repairs' },
  { name: 'Joaquim Ferreira-Holt', role: 'Treasurer' },
];

export default function About() {
  return (
    <>
      <h1>About Pegroom</h1>
      <p className="lead">Pegroom is a tool library run by the members of Larchmere Commons.</p>
      <p>Most drills are used for a few minutes a year. Instead of every household owning one, we keep a good one on a shelf, look after it, and lend it out. The same goes for sanders, ladders, sewing machines and the hedge trimmer everyone needs once in June.</p>
      <h2>How we started</h2>
      <p>Pegroom began in a borrowed garage with a box of tools neighbours no longer needed. Today we rent a unit on Mill Lane with a lending desk and a shared workshop, and the library is still run by volunteers.</p>
      <h2>Who runs it</h2>
      <div className="grid">
        {STEWARDS.map(s => (
          <div className="card" key={s.name}>
            <h3>{s.name}</h3>
            <p className="muted">{s.role}</p>
          </div>
        ))}
      </div>
      <h2>Where we are</h2>
      <p>Unit 4, Larchmere Yard, Mill Lane. The entrance is next to the bike racks.</p>
      <div className="actions">
        <Link className="btn" to="/plans">See membership plans</Link>
      </div>
    </>
  );
}
