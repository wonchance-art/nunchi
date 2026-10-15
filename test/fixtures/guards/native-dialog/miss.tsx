// Synthetic fixture (nunchi guard native-dialog): near misses, none of them a browser dialog.
import { confirm } from './dialog';
// window.confirm('in a comment')
const text = "window.confirm('in a string')";
const api = { alert: (m: string) => m };
export async function RemovePlant() {
  await confirm('Remove this fern?');
  api.alert('not the browser');
  dialog.confirm('a method of another object');
  const shelf = { prompt: () => true };
  shelf.prompt();
  confirm`Remove this pot?`;
  api.alert`not the browser`;
  const note = String.raw`alert('in a raw string')`;
  return <p title="alert('x')">{text}</p>;
}
