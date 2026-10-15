// Synthetic fixture (nunchi guard raw-message): near misses. The first one is the stated limit: there is no data
// flow, so a message stored in a variable and rendered as {m} is not seen. A form library's validation message
// (errors, formState, fieldState) is written for people, and a toast's or a chat message's is not an error's.
import styles from './watering.module.css';
export function WateringFailed({ error, t, errors, form, fieldState, toast, m }: { error: Error; t: (k: string) => string; errors: any; form: any; fieldState: any; toast: any; m: any }) {
  const msg = error.message;
  console.error(error.message);
  toast(error.message);
  return (
    <div className={styles.message} key={error.message}>
      <p>{msg}</p>
      <p>{t('message')}</p>
      <p>{error.message.length} characters</p>
      <p>{messages.length}</p>
      <p>{form.messageId}</p>
      {/* {error.message} in a comment */}
      <p>{errors.email?.message}</p>
      <p>{form.formState.errors.name?.message}</p>
      <p>{fieldState.error?.message}</p>
      <p>{toast.message}</p>
      <p>{m.message}</p>
      <p>{t(error.message)}</p>
    </div>
  );
}
