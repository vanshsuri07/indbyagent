/**
 * Date poll ranking logic:
 * - Ranks must be unique (no two dates share the same rank).
 * - Unranked dates are represented internally as rank 0 and are never submitted.
 * - When a user selects a rank already assigned to another date,
 *   automatically swap the two dates' ranks.
 * - When a user clears a date's rank (selects "–"), set that date to rank 0 (unranked).
 * - The submitted ranking includes only ranked dates (rank > 0), ordered by rank ascending.
 */

/**
 * Computes initial ranks from a saved ranking.
 * Options present in `mine` (in order) receive ranks 1, 2, 3, … matching their position.
 * Options NOT in `mine` receive rank 0 (unranked / blank "–").
 * If `mine` is empty or omitted, all options start unranked (rank 0).
 */
export function computeInitialRanks(options: string[], mine?: string[] | null): number[] {
  const ranks: number[] = new Array(options.length).fill(0);
  if (!mine || mine.length === 0) return ranks;

  for (let r = 0; r < mine.length && r < options.length; r++) {
    const opt = mine[r];
    const optIdx = options.findIndex(
      (o) => o.toLowerCase() === opt.toLowerCase() || Date.parse(o) === Date.parse(opt),
    );
    if (optIdx !== -1 && ranks[optIdx] === 0) {
      ranks[optIdx] = r + 1;
    }
  }

  return ranks;
}

/**
 * When a user changes the rank of option at `changedIndex` to `newRankInput`:
 * - If `newRankInput` is "" or 0: clear that date's rank (set to 0 / unranked).
 * - If `newRankInput` is a real rank already held by another date: swap the two.
 * - Otherwise: assign the new rank normally.
 *
 * Example (full-ranking swap): row-order ranks [3, 1, 2] become [1, 3, 2]
 * when index 0 changes from 3 → 1.
 *
 * Example (clear): row-order ranks [3, 1, 2] become [0, 1, 2]
 * when index 0 is cleared (newRankInput = "").
 */
export function swapRanks(
  ranks: number[],
  changedIndex: number,
  newRankInput: number | string,
): number[] {
  const newRank = newRankInput === "" ? 0 : Number(newRankInput);
  const result = [...ranks];
  const oldRank = result[changedIndex];
  if (oldRank === newRank) return result;

  if (newRank === 0) {
    // Clearing: just unrank this date, leave all others unchanged.
    result[changedIndex] = 0;
    return result;
  }

  // Assigning a real rank: if another date holds this rank, swap it to oldRank.
  const otherIndex = result.findIndex((r, idx) => idx !== changedIndex && r === newRank);
  if (otherIndex !== -1) {
    result[otherIndex] = oldRank; // oldRank may be 0 (was unranked → now unranked)
  }
  result[changedIndex] = newRank;
  return result;
}

/**
 * Returns the poll options that have been ranked (rank > 0), sorted by rank ascending.
 * Unranked options (rank = 0) are excluded.
 */
export function getSubmittedRanking(options: string[], ranks: number[]): string[] {
  return options
    .map((opt, i) => ({ opt, rank: ranks[i] }))
    .filter((x) => x.rank > 0)
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.opt);
}
