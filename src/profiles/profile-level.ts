const LEVELS: { minTdh: number; level: number }[] = [
  { minTdh: 0, level: 0 },
  {
    minTdh: 25,
    level: 1
  },
  {
    minTdh: 50,
    level: 2
  },
  {
    minTdh: 100,
    level: 3
  },
  {
    minTdh: 250,
    level: 4
  },
  {
    minTdh: 500,
    level: 5
  },
  {
    minTdh: 1000,
    level: 6
  },
  {
    minTdh: 1500,
    level: 7
  },
  {
    minTdh: 3000,
    level: 8
  },
  {
    minTdh: 5000,
    level: 9
  },
  {
    minTdh: 7500,
    level: 10
  },
  {
    minTdh: 10000,
    level: 11
  },
  {
    minTdh: 15000,
    level: 12
  },
  {
    minTdh: 20000,
    level: 13
  },
  {
    minTdh: 25000,
    level: 14
  },
  {
    minTdh: 30000,
    level: 15
  },
  {
    minTdh: 35000,
    level: 16
  },
  {
    minTdh: 40000,
    level: 17
  },
  {
    minTdh: 45000,
    level: 18
  },
  {
    minTdh: 50000,
    level: 19
  },
  {
    minTdh: 60000,
    level: 20
  },
  {
    minTdh: 70000,
    level: 21
  },
  {
    minTdh: 80000,
    level: 22
  },
  {
    minTdh: 90000,
    level: 23
  },
  {
    minTdh: 100000,
    level: 24
  },
  {
    minTdh: 110000,
    level: 25
  },
  {
    minTdh: 120000,
    level: 26
  },
  {
    minTdh: 130000,
    level: 27
  },
  {
    minTdh: 140000,
    level: 28
  },
  {
    minTdh: 150000,
    level: 29
  },
  {
    minTdh: 160000,
    level: 30
  },
  {
    minTdh: 170000,
    level: 31
  },
  {
    minTdh: 180000,
    level: 32
  },
  {
    minTdh: 190000,
    level: 33
  },
  {
    minTdh: 200000,
    level: 34
  },
  {
    minTdh: 220000,
    level: 35
  },
  {
    minTdh: 240000,
    level: 36
  },
  {
    minTdh: 260000,
    level: 37
  },
  {
    minTdh: 280000,
    level: 38
  },
  {
    minTdh: 300000,
    level: 39
  },
  {
    minTdh: 320000,
    level: 40
  },
  {
    minTdh: 340000,
    level: 41
  },
  {
    minTdh: 360000,
    level: 42
  },
  {
    minTdh: 380000,
    level: 43
  },
  {
    minTdh: 400000,
    level: 44
  },
  {
    minTdh: 420000,
    level: 45
  },
  {
    minTdh: 440000,
    level: 46
  },
  {
    minTdh: 460000,
    level: 47
  },
  {
    minTdh: 480000,
    level: 48
  },
  {
    minTdh: 500000,
    level: 49
  },
  {
    minTdh: 550000,
    level: 50
  },
  {
    minTdh: 600000,
    level: 51
  },
  {
    minTdh: 650000,
    level: 52
  },
  {
    minTdh: 700000,
    level: 53
  },
  {
    minTdh: 750000,
    level: 54
  },
  {
    minTdh: 800000,
    level: 55
  },
  {
    minTdh: 850000,
    level: 56
  },
  {
    minTdh: 900000,
    level: 57
  },
  {
    minTdh: 950000,
    level: 58
  },
  {
    minTdh: 1000000,
    level: 59
  },
  {
    minTdh: 1250000,
    level: 60
  },
  {
    minTdh: 1500000,
    level: 61
  },
  {
    minTdh: 1750000,
    level: 62
  },
  {
    minTdh: 2000000,
    level: 63
  },
  {
    minTdh: 2250000,
    level: 64
  },
  {
    minTdh: 2500000,
    level: 65
  },
  {
    minTdh: 2750000,
    level: 66
  },
  {
    minTdh: 3000000,
    level: 67
  },
  {
    minTdh: 3250000,
    level: 68
  },
  {
    minTdh: 3500000,
    level: 69
  },
  {
    minTdh: 3750000,
    level: 70
  },
  {
    minTdh: 4000000,
    level: 71
  },
  {
    minTdh: 4250000,
    level: 72
  },
  {
    minTdh: 4500000,
    level: 73
  },
  {
    minTdh: 4750000,
    level: 74
  },
  {
    minTdh: 5000000,
    level: 75
  },
  {
    minTdh: 5500000,
    level: 76
  },
  {
    minTdh: 6000000,
    level: 77
  },
  {
    minTdh: 6500000,
    level: 78
  },
  {
    minTdh: 7000000,
    level: 79
  },
  {
    minTdh: 7500000,
    level: 80
  },
  {
    minTdh: 8000000,
    level: 81
  },
  {
    minTdh: 8500000,
    level: 82
  },
  {
    minTdh: 9000000,
    level: 83
  },
  {
    minTdh: 9500000,
    level: 84
  },
  {
    minTdh: 10000000,
    level: 85
  },
  {
    minTdh: 11000000,
    level: 86
  },
  {
    minTdh: 12000000,
    level: 87
  },
  {
    minTdh: 13000000,
    level: 88
  },
  {
    minTdh: 14000000,
    level: 89
  },
  {
    minTdh: 15000000,
    level: 90
  },
  {
    minTdh: 16000000,
    level: 91
  },
  {
    minTdh: 17000000,
    level: 92
  },
  {
    minTdh: 18000000,
    level: 93
  },
  {
    minTdh: 19000000,
    level: 94
  },
  {
    minTdh: 20000000,
    level: 95
  },
  {
    minTdh: 21000000,
    level: 96
  },
  {
    minTdh: 22000000,
    level: 97
  },
  {
    minTdh: 23000000,
    level: 98
  },
  {
    minTdh: 24000000,
    level: 99
  },
  {
    minTdh: 25000000,
    level: 100
  }
].reverse();

// LEVELS runs from the top: its first entry is level 100.
const TABLE_TOP_LEVEL = LEVELS[0].level;
const TABLE_TOP_BORDER = LEVELS[0].minTdh;

/**
 * Above level 100 there is no cap. Each level needs the previous border plus
 * a 25th of it, rounded down: 101 needs 26,000,000, 102 needs 27,040,000,
 * 150 needs 177,667,015 and 200 needs 1,262,623,144.
 */
function nextBorderAbove100(border: number): number {
  // Integer division with no rounded float quotient: border - border % 25
  // is a multiple of 25, so dividing it is exact.
  return border + (border - (border % 25)) / 25;
}

/**
 * Borders from level 100 up, while they are safe integers (up to 2^53 - 1,
 * Number.MAX_SAFE_INTEGER): index i holds level 100 + i. The last one is
 * level 602 at 8,885,382,734,061,690; the border of 603 is past 2^53 - 1.
 */
const BORDERS_FROM_100: number[] = [TABLE_TOP_BORDER];
for (
  let next = nextBorderAbove100(TABLE_TOP_BORDER);
  next <= Number.MAX_SAFE_INTEGER;
  next = nextBorderAbove100(next)
) {
  BORDERS_FROM_100.push(next);
}

export function calculateLevel({
  tdh,
  rep
}: {
  tdh: number;
  rep: number;
}): number {
  return getLevelFromScore(+tdh + +rep);
}

/**
 * The level of a raw score. Scores below 25, negative scores and NaN are
 * level 0. JS numbers hold scores exactly only as safe integers (up to
 * 2^53 - 1). A larger score reads as level 602, the last level whose border
 * is a safe integer.
 */
export function getLevelFromScore(score: number): number {
  if (score >= TABLE_TOP_BORDER) {
    return TABLE_TOP_LEVEL + lastBorderIndexAtOrBelow(score);
  }
  return LEVELS.find((l) => score >= l.minTdh)?.level ?? 0;
}

/** Binary search for the highest index whose border is at or below score. */
function lastBorderIndexAtOrBelow(score: number): number {
  let low = 0;
  let high = BORDERS_FROM_100.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (BORDERS_FROM_100[middle] <= score) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/**
 * The lowest raw score of a level. Negative levels return themselves. A
 * level whose border is not a safe integer (603 and up, past 2^53 - 1)
 * returns Number.MAX_SAFE_INTEGER, a score no identity can reach, so SQL
 * bounds built from it stay exact in practice.
 */
export function getLevelComponentsBorderByLevel(level: number): number {
  if (level < 0) {
    return level;
  }
  if (level > TABLE_TOP_LEVEL) {
    return BORDERS_FROM_100[level - TABLE_TOP_LEVEL] ?? Number.MAX_SAFE_INTEGER;
  }
  return LEVELS.find((l) => l.level === level)?.minTdh ?? 0;
}
