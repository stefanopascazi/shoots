/**
 * Minimal dense linear algebra for multi-output ridge.
 *
 * The develop head is P independent ridge regressions that all share the same
 * normal-equation matrix A = XcᵀXc + λI (it depends only on the features, not on
 * which parameter we predict). So we Cholesky-factor A ONCE and back-substitute
 * each parameter's right-hand side — O(D³) once, O(D²) per parameter. No external
 * math library, keeping the licence clean.
 */

/** Lower-triangular Cholesky factor L of a symmetric positive-definite A (A = L·Lᵀ). */
export function choleskyFactor(A: number[][]): Float64Array[] {
  const n = A.length;
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
  return L;
}

/** Solve A·x = b given A's Cholesky factor L (forward then back substitution). */
export function solveCholesky(L: Float64Array[], b: number[]): number[] {
  const n = L.length;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const Li = L[i]!;
    let sum = b[i]!;
    for (let k = 0; k < i; k++) sum -= Li[k]! * y[k]!;
    y[i] = sum / Li[i]!;
  }
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
