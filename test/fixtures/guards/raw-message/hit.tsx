// Synthetic fixture (nunchi guard raw-message): every line marked HIT renders an error's raw message.
export function WateringFailed({ error, err, loadError, query }: { error: Error; err?: Error; loadError: Error; query: { error: Error } }) {
  return (
    <div>
      <p>{error.message}</p>{/* HIT raw-message */}
      <p>{err?.message}</p>{/* HIT raw-message */}
      <p>{(error as Error).message}</p>{/* HIT raw-message */}
      <p>{error && error.message}</p>{/* HIT raw-message */}
      <p>{error.message ?? 'Something went wrong'}</p>{/* HIT raw-message */}
      <Banner title={error.message} />{/* HIT raw-message */}
      <p>{error['message']}</p>{/* HIT raw-message */}
      <pre>{error.message}</pre>{/* HIT raw-message */}
      <p>{`Failed: ${error.message}`}</p>{/* HIT raw-message */}
      <p>{String(loadError.message)}</p>{/* HIT raw-message */}
      <p>{'Error: ' + query.error.message}</p>{/* HIT raw-message */}
      <p>{err?.message.toString()}</p>{/* HIT raw-message */}
      <p>{err?.response?.data?.message}</p>{/* HIT raw-message */}
    </div>
  );
}
