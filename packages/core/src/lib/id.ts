/** Prisma-compatible cuid-ish id for text PKs (benefits, etc.). */
export function createCuid(): string {
  const time = Date.now().toString(36);
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"; // base36
  // Rejection sampling avoids the modulo bias of `b % 36` (256 % 36 !== 0).
  const max = Math.floor(256 / alphabet.length) * alphabet.length; // 252
  let rand = "";
  while (rand.length < 12) {
    for (const b of crypto.getRandomValues(new Uint8Array(12))) {
      if (b < max) {
        rand += alphabet[b % alphabet.length];
        if (rand.length === 12) break;
      }
    }
  }
  return `c${time}${rand}`;
}
