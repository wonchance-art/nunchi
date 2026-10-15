// Synthetic fixture (nunchi guard dead-href): near misses, every link goes somewhere.
const links = [{ href: '#', label: 'Home' }];
// <a href="#">in a comment</a>
export function ShelfNav({ id }: { id: string }) {
  return (
    <nav>
      <a href="#top">Back to top</a>
      <a href={`#${id}`}>Section</a>
      <a href={'#' + id}>Section</a>
      <a data-href="#">Data</a>
      <a href="/javascript-guide">Guide</a>
      <a href="https://example.invalid/#">Out</a>
      {links.map(l => <a key={l.label} href={l.href}>{l.label}</a>)}
    </nav>
  );
}
