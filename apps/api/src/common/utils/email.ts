// Shared e-mail validation. The pattern uses adjacent `[^\s@]+` groups which
// can backtrack polynomially, so we bound the input length first (RFC 5321
// caps an address at 254 chars). This length guard is what keeps a
// pathological input from causing a ReDoS (CodeQL js/polynomial-redos).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}
