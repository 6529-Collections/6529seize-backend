export function areEqualAddresses(w1: string, w2: string) {
  if (!w1 || !w2) {
    return false;
  }
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

export function areEqualObjects(obj1: any, obj2: any) {
  for (const property in obj1) {
    const value1 = obj1[property];
    const value2 = obj2[property];
    if (typeof value1 === 'object' && value1 !== null) {
      if (!areEqualObjects(value1, value2)) {
        return false;
      }
    } else if (value1 != value2) {
      console.log(property, obj1[property], obj2[property]);
      return false;
    }
  }
  return true;
}

export function formatAddress(address: string) {
  if (!address || !address.startsWith('0x')) {
    return address;
  }
  return `${address.substring(0, 5)}...${address.substring(
    address.length - 3
  )}`;
}
