export function fuzzyScore(value: string, query: string): number {
  const text = value.toLocaleLowerCase();
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 0;

  let score = 0;
  let position = -1;
  let streak = 0;
  for (const character of needle) {
    const next = text.indexOf(character, position + 1);
    if (next < 0) return -1;
    streak = next === position + 1 ? streak + 1 : 0;
    score += streak * 4 - Math.max(0, next - position - 1);
    if (next === 0 || "/\\._- ".includes(text[next - 1])) score += 12;
    position = next;
  }
  return score - Math.max(0, text.length - needle.length) / 100;
}

export function rankFuzzy<T>(items: T[], query: string, targets: (item: T) => string[]): T[] {
  const needle = query.trim();
  if (!needle) return items;
  return items
    .map((item, index) => ({
      item,
      index,
      // The +24 is a tie-breaker for a hit on the primary target, never a floor. Added to a miss it
      // made every item "match" (-1 + 24 = 23), so the filter below never rejected anything: a `@zzz`
      // mention listed eight arbitrary files, and a quick-switch query kept every session.
      score: Math.max(...targets(item).map((target, targetIndex) => {
        const base = fuzzyScore(target, needle);
        return base < 0 ? -1 : base + (targetIndex === 0 ? 24 : 0);
      })),
    }))
    .filter((result) => result.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((result) => result.item);
}
