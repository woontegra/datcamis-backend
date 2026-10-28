import "./helpers/local-database";
import { expect, test } from "vitest";
import { checkoutBodySchema } from "../src/orders/checkout";
import {
  PROVINCE_NAMES,
  TURKEY_DISTRICT_COUNT,
  TURKEY_PROVINCE_COUNT,
  foldTr,
  isTurkeyCityDistrict,
} from "../src/orders/turkey-locations";

const base = {
  email: "ilce@datcamis.local",
  shippingAddress: {
    fullName: "Ayşe Teslimat",
    phone: "05551112233",
    line1: "Teslimat cad. 1",
    district: "Datça",
    city: "Muğla",
    postalCode: "48900",
    country: "TR",
  },
  invoice: { type: "INDIVIDUAL" as const, personName: "Ayşe Teslimat", sameAsShipping: true },
  paymentMethod: "havale" as const,
  termsAccepted: true as const,
};

test("81 il ve 973 ilçe sabit listede", () => {
  expect(TURKEY_PROVINCE_COUNT).toBe(81);
  expect(PROVINCE_NAMES).toHaveLength(81);
  expect(TURKEY_DISTRICT_COUNT).toBe(973);
  expect(isTurkeyCityDistrict("Muğla", "Datça")).toBe(true);
  expect(isTurkeyCityDistrict("İstanbul", "Datça")).toBe(false);
  expect(foldTr("MUĞ")).toBe("mug");
  expect(foldTr("muğla")).toBe("mugla");
});

test("uymayan ilçe reddedilir", () => {
  const result = checkoutBodySchema.safeParse({
    ...base,
    shippingAddress: { ...base.shippingAddress, city: "İstanbul", district: "Datça" },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.some((issue) => issue.path.join(".") === "shippingAddress.district")).toBe(true);
});

test("Muğla Datça kabul edilir", () => {
  const result = checkoutBodySchema.safeParse(base);
  expect(result.success).toBe(true);
});

test("bireysel aynı teslimatta fatura adı istenmez", () => {
  const result = checkoutBodySchema.safeParse({
    ...base,
    invoice: { type: "INDIVIDUAL", sameAsShipping: true },
  });
  expect(result.success).toBe(true);
});
