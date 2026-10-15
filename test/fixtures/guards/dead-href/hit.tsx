// Synthetic fixture (nunchi guard dead-href): every line marked HIT is a link that goes nowhere.
export function ShelfNav({ open }: { open: boolean }) {
  return (
    <nav>
      <a href="#">Home</a>{/* HIT dead-href */}
      <Link href={'#'}>Plants</Link>{/* HIT dead-href */}
      <a href={`#`}>Pots</a>{/* HIT dead-href */}
      <a href="javascript:void(0)">Help</a>{/* HIT dead-href */}
      <a href=" JavaScript:open()">Chat</a>{/* HIT dead-href */}
      <a href={open ? '#' : '/cart'}>Cart</a>{/* HIT dead-href */}
    </nav>
  );
}
