// Synthetic fixture (nunchi guard colour-literal; tokens #1f2937, #ffffff, rgb(37, 99, 235)): near misses. Token
// colours in other spellings, a custom property, a variable's fallback, a font named like a colour, Tailwind palette
// classes, and a theme object in code (a stated limit: only JSX style, class names, SVG colour attributes and .css).
const theme = { primary: '#ff0000' };
export function FernCard() {
  return (
    <div
      style={{ color: '#1F2937', background: 'white', borderColor: 'rgb(37 99 235)', '--accent': '#ff0000', outlineColor: 'var(--ring, #ff0000)', fontFamily: 'Tomato Sans' }}
      className="bg-red-500 text-[var(--brand)] p-[3px]"
    >
      <svg><path fill="none" stroke="currentColor" /></svg>
      <p title="#ff0000">{theme.primary}</p>
    </div>
  );
}
