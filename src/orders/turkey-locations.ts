import { TURKEY_DISTRICTS } from "./turkey-districts";

export { TURKEY_DISTRICTS };

export const PROVINCE_NAMES = Object.keys(TURKEY_DISTRICTS).sort((a, b) => a.localeCompare(b, "tr"));

export const TURKEY_PROVINCE_COUNT = PROVINCE_NAMES.length;
export const TURKEY_DISTRICT_COUNT = Object.values(TURKEY_DISTRICTS).reduce((sum, list) => sum + list.length, 0);

export function foldTr(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("tr")
    .replaceAll("ç", "c")
    .replaceAll("ğ", "g")
    .replaceAll("ı", "i")
    .replaceAll("ö", "o")
    .replaceAll("ş", "s")
    .replaceAll("ü", "u");
}

export function districtsOf(city: string) {
  return TURKEY_DISTRICTS[city] ?? [];
}

export function isTurkeyCityDistrict(city: string, district: string) {
  return districtsOf(city).includes(district);
}
