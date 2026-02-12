export function tokenize(text: string): string[] {
  const input = (text || "").toLowerCase();
  const latin = input.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const cjk = input.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? [];

  if (latin.length > 0) {
    return latin;
  }

  if (cjk.length > 0) {
    const grams: string[] = [];
    for (let idx = 0; idx < cjk.length; idx += 1) {
      const token = `${cjk[idx]}${cjk[idx + 1] ?? ""}`;
      if (token.trim().length > 0) {
        grams.push(token);
      }
    }
    return grams;
  }

  return input.split(/\s+/).filter((item) => item.length > 0);
}

function hashToken(token: string): bigint {
  let hash = 1469598103934665603n;
  for (let idx = 0; idx < token.length; idx += 1) {
    hash ^= BigInt(token.charCodeAt(idx));
    hash *= 1099511628211n;
  }
  return hash & ((1n << 64n) - 1n);
}

export function computeSimhash(text: string): bigint {
  const tokens = tokenize(text);
  const bits = new Array<number>(64).fill(0);
  for (const token of tokens) {
    const h = hashToken(token);
    for (let bit = 0; bit < 64; bit += 1) {
      bits[bit] += Number((h >> BigInt(bit)) & 1n) === 1 ? 1 : -1;
    }
  }

  let out = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if (bits[bit] >= 0) {
      out |= 1n << BigInt(bit);
    }
  }
  return out;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let value = a ^ b;
  let count = 0;
  while (value !== 0n) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

export function titleSimilarity(a: string, b: string): number {
  const aa = (a || "").toLowerCase();
  const bb = (b || "").toLowerCase();
  if (!aa || !bb) {
    return 0;
  }

  const aTokens = new Set(tokenize(aa));
  const bTokens = new Set(tokenize(bb));
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union > 0 ? intersection / union : 0;
}

export function localEmbedding(text: string, dimensions = 128): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const hash = Number(hashToken(token) % BigInt(dimensions));
    vector[hash] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const dimensions = Math.min(a.length, b.length);
  if (dimensions === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let idx = 0; idx < dimensions; idx += 1) {
    dot += a[idx] * b[idx];
    normA += a[idx] * a[idx];
    normB += b[idx] * b[idx];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
