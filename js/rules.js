// 競技規則(RRS Part 2 の簡易判定)
const LEN = 4.72;
export const RULE_TEXT = {
  10: 'ルール10: 異なるタックでは左舷艇が右舷艇を避ける',
  11: 'ルール11: 同じタックでオーバーラップ時は風上艇が風下艇を避ける',
  12: 'ルール12: 同じタックでは後続のクリアアスターン艇が避ける',
  13: 'ルール13: タック中の艇は他艇を避ける',
  18: 'ルール18: マークルーム(アウトサイド艇はインサイド艇に余地を与える)',
  31: 'ルール31: マークに触れてはならない',
};

// A, B の接触時に避ける義務があった艇(give-way)を返す
export function giveWayBoat(A, B, obstacles) {
  const res = (gw, rule) => ({ gw, rule, text: RULE_TEXT[rule] });
  if (A.tacking !== B.tacking) return res(A.tacking ? A : B, 13);
  if (A.tack !== B.tack) return res(A.tack < 0 ? A : B, 10);
  const dx = Math.sin(A.h), dz = -Math.cos(A.h);
  const s = (B.x - A.x) * dx + (B.z - A.z) * dz; // B が A より前なら正
  const overlapped = Math.abs(s) < LEN;
  if (overlapped) {
    // マークルーム
    if (obstacles) {
      for (const o of obstacles) {
        if (o.r > 3) continue;
        const dA = Math.hypot(A.x - o.x, A.z - o.z), dB = Math.hypot(B.x - o.x, B.z - o.z);
        if (dA < LEN * 3 && dB < LEN * 3) return res(dA < dB ? B : A, 18);
      }
    }
    return res(A.a > B.a ? A : B, 11);
  }
  return res(s > 0 ? A : B, 12);
}
