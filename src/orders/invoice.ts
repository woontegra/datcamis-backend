export function isValidTckn(value: string) {
  if (!/^[1-9]\d{10}$/.test(value)) return false;
  const digits = value.split("").map(Number);
  const odd = digits[0] + digits[2] + digits[4] + digits[6] + digits[8];
  const even = digits[1] + digits[3] + digits[5] + digits[7];
  const tenth = (((odd * 7) - even) % 10 + 10) % 10;
  if (tenth !== digits[9]) return false;
  const eleventh = digits.slice(0, 10).reduce((sum, digit) => sum + digit, 0) % 10;
  return eleventh === digits[10];
}

export function isValidTaxNumber(value: string) {
  return /^\d{10}$/.test(value);
}
