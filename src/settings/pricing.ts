import { readSection, type StoreSettings } from "./store-settings";

export type PricingSettings = Pick<StoreSettings, "shipping" | "payment">;

/** Shipping is a service taxed at the general rate, independent of the products in the cart. */
const SHIPPING_VAT_RATE = 20;

export function formatTl(amount: number) {
  const abs = Math.abs(Math.trunc(amount));
  const lira = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${amount < 0 ? "-" : ""}${lira},${String(abs % 100).padStart(2, "0")} TL`;
}

export async function readPricingSettings(): Promise<PricingSettings> {
  const [shipping, payment] = await Promise.all([readSection("shipping"), readSection("payment")]);
  return { shipping, payment };
}

/** `productTotal` is what the customer pays for products (after discounts), never the undiscounted list price. */
export function quoteShipping(productTotal: number, shipping: PricingSettings["shipping"]) {
  const threshold = shipping.freeShippingEnabled && shipping.freeShippingThreshold ? shipping.freeShippingThreshold : null;
  if (productTotal <= 0) return { shippingAmount: 0, freeShippingThreshold: threshold, freeShippingRemaining: null };
  if (threshold !== null && productTotal >= threshold) {
    return { shippingAmount: 0, freeShippingThreshold: threshold, freeShippingRemaining: 0 };
  }
  return {
    shippingAmount: shipping.flatFee,
    freeShippingThreshold: threshold,
    freeShippingRemaining: threshold === null || shipping.flatFee === 0 ? null : threshold - productTotal,
  };
}

export function includedVat(amount: number, rate: number) {
  return rate > 0 ? Math.round((amount * rate) / (100 + rate)) : 0;
}

export function orderTotals(
  lines: Array<{ lineAmount: number; vatRate: number | null }>,
  pricing: PricingSettings,
  discountAmount = 0,
) {
  const subtotalAmount = lines.reduce((sum, line) => sum + line.lineAmount, 0);
  const productTotal = Math.max(0, subtotalAmount - discountAmount);
  const quote = quoteShipping(productTotal, pricing.shipping);
  const minOrderAmount = pricing.payment.minOrderAmount ?? null;
  const minOrderShortfall = minOrderAmount && productTotal < minOrderAmount ? minOrderAmount - productTotal : 0;
  const productVat = lines.reduce((sum, line) => sum + includedVat(line.lineAmount, line.vatRate ?? 0), 0);
  return {
    subtotalAmount,
    discountAmount,
    productTotal,
    shippingAmount: quote.shippingAmount,
    taxAmount: productVat + includedVat(quote.shippingAmount, SHIPPING_VAT_RATE),
    totalAmount: productTotal + quote.shippingAmount,
    freeShippingThreshold: quote.freeShippingThreshold,
    freeShippingRemaining: quote.freeShippingRemaining,
    minOrderAmount,
    minOrderShortfall,
  };
}

export function minOrderMessage(minOrderAmount: number, shortfall: number) {
  return `En düşük sipariş tutarı ${formatTl(minOrderAmount)}. Siparişi tamamlamak için sepetinize ${formatTl(shortfall)} daha ürün ekleyin.`;
}
