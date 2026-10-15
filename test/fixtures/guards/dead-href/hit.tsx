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
      <a href={'\u0001javascript:void(0)'}>Tips</a>{/* HIT dead-href (follow-up: a leading control character is stripped, as browsers do) */}
      <a href="&#1;javascript:void(0)">Care</a>{/* HIT dead-href (follow-up: the same, written as an entity) */}
      <a href="java&#9;script:void(0)">Soil</a>{/* HIT dead-href (follow-up: a tab inside the scheme is dropped) */}
      <a href=" # ">Top</a>{/* HIT dead-href (follow-up: spaces around) */}
    </nav>
  );
}
