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

const ROUNDING_MARKS = new Set(['m1', 'm1a', 'm2', 'm3', 'gL', 'gR']);

// A, B の接触時に避ける義務があった艇(give-way)を返す
export function giveWayBoat(A, B, obstacles) {
  const res = (gw, rule) => ({ gw, rule, text: RULE_TEXT[rule] });
  if (A.tacking !== B.tacking) return res(A.tacking ? A : B, 13);
  if (A.tack !== B.tack) return res(A.tack < 0 ? A : B, 10);

  // 同タック時: 2艇の平均進行方向ベクトル(ux, uz)で前後オーバーラップ(RRS 11/12)を判定し、
  // 風上法線ベクトル(wx, wz)で正確な風上艇・風下艇(リーバウ位置を含む)を判定する
  let ux = Math.sin(A.h) + Math.sin(B.h);
  let uz = -Math.cos(A.h) - Math.cos(B.h);
  const ul = Math.hypot(ux, uz);
  if (ul > 1e-4) { ux /= ul; uz /= ul; } else { ux = Math.sin(A.h); uz = -Math.cos(A.h); }

  const dxAB = B.x - A.x, dzAB = B.z - A.z;
  const s = dxAB * ux + dzAB * uz; // B が A より前なら正
  const overlapped = Math.abs(s) < LEN * 0.92;

  if (overlapped) {
    // マークルーム(RRS 18): スタートマーク(本部船・ピン)やフィニッシュ委員会艇には適用されない(RRS Section C 前文)
    if (obstacles && A.started && B.started && !A.ocs && !B.ocs) {
      for (const o of obstacles) {
        if (o.r > 3 || !ROUNDING_MARKS.has(o.key)) continue;
        const dA = Math.hypot(A.x - o.x, A.z - o.z), dB = Math.hypot(B.x - o.x, B.z - o.z);
        if (dA < LEN * 3 && dB < LEN * 3 && Math.abs(dA - dB) > 0.35) {
          return res(dA < dB ? B : A, 18);
        }
      }
    }
    // 右舷正横ベクトル(rx, rz) = (-uz, ux)。tack=+1(スタボ)なら右舷側が風上、tack=-1(ポート)なら左舷側が風上
    const tack = A.tack || 1;
    const wx = tack * (-uz), wz = tack * ux;
    const windDiff = dxAB * wx + dzAB * wz; // >0 なら B が A の風上側
    if (Math.abs(windDiff) > 0.08) {
      return res(windDiff > 0 ? B : A, 11);
    }
    return res(A.a > B.a ? A : B, 11);
  }
  return res(s > 0 ? A : B, 12);
}
