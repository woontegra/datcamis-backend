export function normalizeIban(value: string) {
  return value.replace(/\s+/g, "").toUpperCase();
}

export function isValidTrIban(value: string) {
  const iban = normalizeIban(value);
  if (!/^TR\d{24}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let expanded = "";
  for (const char of rearranged) {
    expanded += /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
  }
  let rest = 0;
  for (const digit of expanded) {
    rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}
