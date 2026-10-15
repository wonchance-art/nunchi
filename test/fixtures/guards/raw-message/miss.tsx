// Synthetic fixture (nunchi guard raw-message): near misses. The first one is the stated limit: there is no data
// flow, so a message stored in a variable and rendered as {m} is not seen.
import styles from './watering.module.css';
export function WateringFailed({ error, t }: { error: Error; t: (k: string) => string }) {
  const m = error.message;
  console.error(error.message);
  toast(error.message);
  return (
    <div className={styles.message} key={error.message}>
      <p>{m}</p>
      <p>{t('message')}</p>
      <p>{error.message.length} characters</p>
      <p>{messages.length}</p>
      <p>{form.messageId}</p>
      {/* {error.message} in a comment */}
      <p>{`Failed: ${error.message}`}</p>
    </div>
  );
}
