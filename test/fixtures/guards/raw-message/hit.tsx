// Synthetic fixture (nunchi guard raw-message): every line marked HIT renders an error's raw message.
export function WateringFailed({ error, err }: { error: Error; err?: Error }) {
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
    </div>
  );
}
