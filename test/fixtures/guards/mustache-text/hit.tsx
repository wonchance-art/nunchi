// Synthetic fixture (nunchi guard mustache-text): every line marked HIT shows a template placeholder as it is.
export function Greeting() {
  return (
    <section>
      <h1>Hello {'{{name}}'}</h1>{/* HIT mustache-text */}
      <p>{`You have {{count}} ferns`}</p>{/* HIT mustache-text */}
      <p>Water &#123;&#123;plant&#125;&#125; today</p>{/* HIT mustache-text */}
      <input placeholder="Search {{shop}}" />{/* HIT mustache-text */}
      <img alt={'{{plant}} photo'} src="/p.png" />{/* HIT mustache-text */}
    </section>
  );
}
