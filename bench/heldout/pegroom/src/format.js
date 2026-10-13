// Dates come from the API as YYYY-MM-DD and are shown in the workshop's own calendar (UTC).
const at = iso => new Date(`${iso}T12:00:00Z`);

export const formatDay = iso => at(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export const formatDate = iso => at(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const daysUntil = iso => Math.round((at(iso).getTime() - Date.now()) / 86400000);
