// Card payments for membership fees.
export function createPayments(key) {
  return {
    ready: Boolean(key),
    checkout(planId) {
      return fetch('/api/payments/checkout', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ planId }) });
    },
  };
}
