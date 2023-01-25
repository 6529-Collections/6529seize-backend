export function areEqualAddresses(w1: string, w2: string) {
  return w1.toUpperCase() === w2.toUpperCase();
}

export function getDaysDiff(t1: Date, t2: Date, floor = true) {
  const diff = t1.getTime() - t2.getTime();
  if (floor) {
    return Math.floor(diff / (1000 * 3600 * 24));
  }
  return Math.ceil(diff / (1000 * 3600 * 24));
}

export function getLastTDH() {
  const now = new Date();

  const tdh = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );

  if (tdh > now) {
    return new Date(tdh.getTime() - 24 * 60 * 60 * 1000);
  }
  return tdh;
}

export function delay(time: number) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

export function getHoursAgo(date: Date) {
  const now = new Date();
  const msBetweenDates = Math.abs(date.getTime() - now.getTime());
  return msBetweenDates / (60 * 60 * 1000);
}
