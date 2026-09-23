/**
 * CR seat picker — shared by the JSON add-to-ballot flow and the
 * auto-match flow. Gender is only a *preference*: a candidate of any
 * gender can stand on either the Boys or the Girls seat, and candidates
 * with no gender carried by the source still get a deterministic seat.
 *
 * Two modes:
 *  - spread=false (mixed-gender class): gender match dominates, so boys go
 *    to the Boys seat and girls to the Girls seat (existing behavior).
 *  - spread=true (single-gender class: only girls or only boys): the class's
 *    candidates tile ACROSS both seats by occupancy, so two girls in a
 *    no-boys class occupy the Girls seat AND the Boys seat — two girls
 *    become the two CRs instead of piling onto one seat.
 *
 * @param positions position list (each { id, name, gender })
 * @param cand candidate object ({ gender, position, position_name })
 * @param opts { seatCounts: {positionId: count}, spread: boolean }
 * @returns selected seat or null
 */
function pickCrSeat(positions, cand, opts = {}) {
  const { seatCounts = {}, spread = false } = opts;
  const candGender = String(cand.gender || '').trim().toLowerCase();
  const candPos = String(cand.position || cand.position_name || cand.positionName || '');
  const wantGirl = candGender === 'female' || candGender === 'f' || /girl|female/i.test(candPos);
  const seats = (Array.isArray(positions) ? positions.filter(p => p && p.id != null) : []).slice();

  const genderMatch = (p) => {
    if (wantGirl) {
      return /girl|female/i.test(String(p.name || '')) || String(p.gender || '').toLowerCase() === 'female';
    }
    return /boy|male/i.test(String(p.name || '')) && !/girl|female/i.test(String(p.name || ''))
      || String(p.gender || '').toLowerCase() === 'male';
  };

  seats.sort((a, b) => {
    const occA = seatCounts[a.id] || 0;
    const occB = seatCounts[b.id] || 0;
    if (spread) {
      // Single-gender class: least-occupied seat first, gender match only to
      // break ties. This spreads "two girls / two boys" onto both CR seats.
      const occDiff = occA - occB;
      if (occDiff !== 0) return occDiff;
      const matchDiff = Number(genderMatch(b)) - Number(genderMatch(a));
      if (matchDiff !== 0) return matchDiff;
      return String(a.id).localeCompare(String(b.id));
    }
    // Mixed class: gender match dominates, occupancy never overrides it.
    const matchDiff = Number(genderMatch(b)) - Number(genderMatch(a));
    if (matchDiff !== 0) return matchDiff;
    const occDiff = occA - occB;
    if (occDiff !== 0) return occDiff;
    return String(a.id).localeCompare(String(b.id));
  });

  return seats[0] || null;
}

/**
 * Decide whether a class is single-gender (all candidates want the same
 * seat), so placement spreads across both seats instead of piling. A class
 * with no candidates of the "other" gender (no boys when girls exist, or no
 * girls when boys exist) is treated as single-gender.
 */
function isSingleGenderClass(candidates) {
  const arr = Array.isArray(candidates) ? candidates : [];
  let hasGirl = false;
  let hasBoy = false;
  for (const cand of arr) {
    const candGender = String(cand.gender || '').trim().toLowerCase();
    const candPos = String(cand.position || cand.position_name || cand.positionName || '');
    if (candGender === 'female' || candGender === 'f' || /girl|female/i.test(candPos)) hasGirl = true;
    else hasBoy = true;
  }
  return hasGirl !== hasBoy;
}

module.exports = { pickCrSeat, isSingleGenderClass };