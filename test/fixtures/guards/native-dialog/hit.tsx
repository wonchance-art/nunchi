// Synthetic fixture (nunchi guard native-dialog): every line marked HIT calls a browser dialog.
export function RemovePlant({ onRemove }: { onRemove: () => void }) {
  const go = () => {
    if (window.confirm('Remove this fern?')) onRemove(); /* HIT native-dialog */
    alert('Removed'); /* HIT native-dialog */
    globalThis.prompt?.('Why?'); /* HIT native-dialog */
    window['confirm']('Really?'); /* HIT native-dialog */
    window?.alert('Gone'); /* HIT native-dialog */
  };
  return <button onClick={() => confirm('Sure?')}>Remove</button>; /* HIT native-dialog */
}
