/**
 * 決定的な疑似乱数。
 *
 * seed を指定したランを再現できるように、外部依存なしの mulberry32 を自前実装する。
 * 同じ seed と同じ呼び出し順なら、必ず同じ数列を返す。
 */

/**
 * mulberry32 のジェネレータを作る。
 * @param seed 32bit の種。同じ値なら同じ数列を返す。
 * @returns 0 以上 1 未満の乱数を返す関数
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 配列をその場でシャッフルする（Fisher-Yates）。
 * 元の配列を書き換え、同じ配列を返す。
 */
export function shuffleInPlace<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}
