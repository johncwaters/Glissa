export function isCalendarDate(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return false
  const [year, month, day] = dateText.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
