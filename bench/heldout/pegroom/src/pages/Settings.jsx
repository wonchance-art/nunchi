import { Component, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatDate } from '../format.js';

class Boundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="state">
          <h2>Something went wrong</h2>
          <p>{String(this.state.error.message)}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function SettingsForm() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/profile').then(res => res.json()).then(d => setProfile(d.profile));
  }, []);

  if (profile === null) return <p>Loading your settings…</p>;

  const save = e => { e.preventDefault(); setSaved(true); };
  const deleteAccount = () => fetch('/api/profile', { method: 'DELETE' }).then(() => navigate('/'));

  return (
    <div className="settings">
      <h1>Settings</h1>
      <form onSubmit={save}>
        <section className="card">
          <h2>Profile</h2>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" className="input" defaultValue={profile.displayName} />
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" className="input" defaultValue={profile.email} />
          </div>
          <div className="field">
            <label htmlFor="phone">Phone</label>
            <input id="phone" type="tel" className="input" defaultValue={profile.phone} />
          </div>
          <div className="field">
            <p className="label-like">Emergency contact</p>
            <input type="tel" className="input" />
          </div>
          <p className="muted">Member since {formatDate(profile.memberSince)} · {profile.plan} plan · <Link to="/account/billing">Billing and payments</Link></p>
        </section>
        <section className="card">
          <h2>Email updates</h2>
          <label className="check"><input type="checkbox" defaultChecked={profile.newsletter} /> Monthly newsletter</label>
          <p className="muted">FIXME: explain what the newsletter includes</p>
        </section>
        <section className="card">
          <h2>Household</h2>
          {profile.household.length ? (
            <ul>{profile.household.map(h => <li key={h.name}>{h.name} · {h.role}</li>)}</ul>
          ) : (
            <p>No one else is on your membership.</p>
          )}
        </section>
        <div className="actions">
          <button className="btn" type="submit">Save changes</button>
          {saved && <span className="muted" role="status">Changes saved.</span>}
        </div>
      </form>
      <section className="card danger">
        <h2>Delete account</h2>
        <p>Your loan history and bookings will be removed.</p>
        <button type="button" className="btn btn-danger" onClick={deleteAccount}>Delete account</button>
      </section>
    </div>
  );
}

export default function Settings() {
  return <Boundary><SettingsForm /></Boundary>;
}
