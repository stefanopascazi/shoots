/**
 * Minimal dense linear algebra for ridge regression.
 *
 * The only heavy operation is solving a d×d symmetric positive-definite system
 * (d = embedding dim, 512). Cholesky is exact, allocation-light and fast enough
 * at this size — no external math library, keeping the licence clean.
 */

/** Solve A·x = b for symmetric positive-definite A (in place-safe, A copied). */
export function solveSPD(A: number[][], b: number[]): number[] {
  const n = A.length;
  // Cholesky: A = L·Lᵀ, L lower-triangular.
  const L: Float64Array[] = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    const Ai = A[i]!;
    const Li = L[i]!;
    for (let j = 0; j <= i; j++) {
      const Lj = L[j]!;
      let sum = Ai[j]!;
      for (let k = 0; k < j; k++) sum -= Li[k]! * Lj[k]!;
      if (i === j) {
        Li[j] = Math.sqrt(Math.max(sum, 1e-12));
      } else {
        Li[j] = sum / Lj[j]!;
      }
    }
  }
  // Forward solve L·y = b.
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const Li = L[i]!;
    let sum = b[i]!;
    for (let k = 0; k < i; k++) sum -= Li[k]! * y[k]!;
    y[i] = sum / Li[i]!;
  }
  // Back solve Lᵀ·x = y.
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]!;
    for (let k = i + 1; k < n; k++) sum -= L[k]![i]! * x[k]!;
    x[i] = sum / L[i]![i]!;
  }
  return Array.from(x);
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
