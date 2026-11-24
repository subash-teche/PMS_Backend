// The monthly plan. A month is cut into calendar weeks, Monday to Sunday. A month that starts mid-week begins with a
// short W1 (the 1st to the first Sunday), and the last week ends on the last day of the month, so a month has 4 to 6
// weeks. A planned step is stored by a date in its week, so it always lands in the right week of its month.
// slot = { month: 'YYYY-MM', week: 1..6, day?: 1..31 }  (without `day` the plan is for the whole week)

const pad = (n) => String(n).padStart(2, '0');

export const daysIn = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Weekday of the 1st of a month, counting from Monday: 0 is Monday, 6 is Sunday. */
const firstDow = (month) => (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7;

/** The week (1 up to 6) a day of a month falls in. */
export const weekOfDay = (month, day) => Math.floor((day - 1 + firstDow(month)) / 7) + 1;

/** How many weeks a month has: 4 to 6. */
export const weeksIn = (month) => weekOfDay(month, daysIn(month));

/** The days a week covers, e.g. { from: 6, to: 12 }. */
export const weekDays = ({ month, week }) => ({
  from: Math.max(1, (week - 1) * 7 - firstDow(month) + 1),
  to: Math.min(daysIn(month), week * 7 - firstDow(month)),
});

/** The date that is stored: the chosen day, or the first day of the week. */
export const startOfWeek = ({ month, week, day }) => `${month}-${pad(day ?? weekDays({ month, week }).from)}`;

/** The month and week a stored date belongs to. */
export const slotOf = (startDate) => ({
  month: startDate.slice(0, 7),
  week: weekOfDay(startDate.slice(0, 7), Number(startDate.slice(8, 10))),
});

/** Move a YYYY-MM-DD date into another YYYY-MM, clamping the day (31 Jan -> 28 Feb). */
export function shiftDateToMonth(date, month) {
  const day = Math.min(Number(date.slice(8, 10)), daysIn(month));
  return `${month}-${pad(day)}`;
}
