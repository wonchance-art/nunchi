import SiteHeader from '@/components/SiteHeader';

export default function Login() {
  return (
    <>
      <SiteHeader />
      <div className="page login">
        <div className="promo"><p>Plan less.<br />Do more.</p></div>
        <div>
          <h1>Welcome back</h1>
          <form action="/api/login" method="post">
            <input type="email" name="email" placeholder="Email address" />
            <p><button className="btn" type="submit">Login</button></p>
          </form>
        </div>
      </div>
    </>
  );
}
