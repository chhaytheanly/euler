export interface FuzzyMatch {
  score: number;
  positions: number[];
}

const SEPARATORS = /[\s\-_/.:]/;

export function fuzzyMatch(
  text: string,
  query: string
): FuzzyMatch | undefined {
  if (!query) {
    return { score: 0, positions: [] };
  }

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  const exact = haystack.indexOf(needle);
  if (exact >= 0) {
    const boundary =
      exact === 0 || SEPARATORS.test(haystack[exact - 1] ?? "")
        ? 20
        : 0;

    return {
      score: 200 + boundary - exact,
      positions: Array.from(
        { length: needle.length },
        (_, index) => exact + index
      )
    };
  }

  const positions: number[] = [];
  let cursor = 0;
  let gaps = 0;
  let streak = 0;
  let score = 0;

  for (const character of needle) {
    let found = -1;

    while (cursor < haystack.length) {
      if (haystack[cursor] === character) {
        found = cursor;
        break;
      }

      gaps += 1;
      cursor += 1;
    }

    if (found < 0) {
      return undefined;
    }

    const boundary =
      found === 0 || SEPARATORS.test(haystack[found - 1] ?? "");

    if (
      positions.length > 0 &&
      found === positions[positions.length - 1] + 1
    ) {
      streak += 1;
      score += 8 + streak * 4;
    } else {
      streak = 0;
      score += 4;
    }

    if (boundary) {
      score += 12;
    }

    positions.push(found);
    cursor = found + 1;
  }

  return {
    score: score - gaps * 0.3 - haystack.length * 0.02,
    positions
  };
}

export interface RankedItem<T> {
  item: T;
  score: number;
  /** Matched positions in the item's label, for highlighting. */
  positions: number[];
}

interface Rankable {
  label: string;
  value: string;
  description?: string;
  badge?: string;
}

export function rankItems<T extends Rankable>(
  items: T[],
  query: string
): RankedItem<T>[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return items.map((item) => ({
      item,
      score: 0,
      positions: []
    }));
  }

  const ranked: RankedItem<T>[] = [];

  for (const item of items) {
    const fields = [
      { text: item.label, weight: 3, label: true },
      { text: item.value, weight: 2, label: false },
      { text: item.description ?? "", weight: 1, label: false },
      { text: item.badge ?? "", weight: 1, label: false }
    ];

    let total = 0;
    const labelPositions: number[] = [];
    let matched = true;

    for (const token of tokens) {
      let best:
        | { score: number; positions: number[]; label: boolean }
        | undefined;

      for (const field of fields) {
        const match = fuzzyMatch(field.text, token);

        if (!match) {
          continue;
        }

        const weighted = match.score * field.weight;

        if (!best || weighted > best.score) {
          best = {
            score: weighted,
            positions: match.positions,
            label: field.label
          };
        }
      }

      if (!best) {
        matched = false;
        break;
      }

      total += best.score;

      if (best.label) {
        labelPositions.push(...best.positions);
      }
    }

    if (matched) {
      ranked.push({
        item,
        score: total,
        positions: [...new Set(labelPositions)].sort((a, b) => a - b)
      });
    }
  }

  return ranked.sort((a, b) => b.score - a.score);
}
