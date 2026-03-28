/** Polymarket CLOB `signatureType` values (see @polymarket/clob-client). */
export const SignatureType = {
  EOA: 0,
  POLY_PROXY: 1,
  GNOSIS_SAFE: 2
} as const;

export type SignatureTypeValue = (typeof SignatureType)[keyof typeof SignatureType];

export function signatureTypeModeName(t: number): "EOA" | "POLY_PROXY" | "GNOSIS_SAFE" | "UNKNOWN" {
  if (t === SignatureType.EOA) return "EOA";
  if (t === SignatureType.POLY_PROXY) return "POLY_PROXY";
  if (t === SignatureType.GNOSIS_SAFE) return "GNOSIS_SAFE";
  return "UNKNOWN";
}
