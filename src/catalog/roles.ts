import type { StaffRole } from "@prisma/client";

export const PRODUCT_VIEW_ROLES: StaffRole[] = ["OWNER", "ADMIN", "EDITOR", "ORDER_STAFF"];
export const PRODUCT_CONTENT_ROLES: StaffRole[] = ["OWNER", "ADMIN", "EDITOR"];
export const PRODUCT_PRICE_ROLES: StaffRole[] = ["OWNER", "ADMIN"];
export const PRODUCT_STOCK_ROLES: StaffRole[] = ["OWNER", "ADMIN"];
export const PRODUCT_ARCHIVE_ROLES: StaffRole[] = ["OWNER", "ADMIN"];

export function canEditProductContent(role: StaffRole) {
  return PRODUCT_CONTENT_ROLES.includes(role);
}

export function canEditProductPrice(role: StaffRole) {
  return PRODUCT_PRICE_ROLES.includes(role);
}

export function canEditProductStock(role: StaffRole) {
  return PRODUCT_STOCK_ROLES.includes(role);
}

export function canArchiveProduct(role: StaffRole) {
  return PRODUCT_ARCHIVE_ROLES.includes(role);
}
