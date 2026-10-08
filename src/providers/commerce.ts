import type { Env } from "../config/env";

export type ProviderResult = {
  provider: string;
  status: "PENDING";
  providerRef: null;
  metadata: Record<string, unknown>;
};

export interface PaymentProvider {
  createPayment(input: { orderNumber: string; amount: number; currency: string }): ProviderResult;
}

export interface ShippingProvider {
  createShipment(input: { orderNumber: string }): ProviderResult;
}

export class UnconfiguredPaymentProvider implements PaymentProvider {
  constructor(private configuredName: string) {}

  createPayment(): ProviderResult {
    return {
      provider: "unconfigured",
      status: "PENDING",
      providerRef: null,
      metadata: {
        requestedProvider: this.configuredName,
        reason: "Ödeme sağlayıcısı credential'ı tanımlı değil.",
      },
    };
  }
}

export class UnconfiguredShippingProvider implements ShippingProvider {
  constructor(private configuredName: string) {}

  createShipment(): ProviderResult {
    return {
      provider: "unconfigured",
      status: "PENDING",
      providerRef: null,
      metadata: {
        requestedProvider: this.configuredName,
        reason: "Kargo sağlayıcısı credential'ı tanımlı değil.",
      },
    };
  }
}

export function createPaymentProvider(env: Env): PaymentProvider {
  if (env.PAYMENT_PROVIDER !== "unconfigured") {
    return new UnconfiguredPaymentProvider(env.PAYMENT_PROVIDER);
  }
  return new UnconfiguredPaymentProvider("unconfigured");
}

export function createShippingProvider(env: Env): ShippingProvider {
  return new UnconfiguredShippingProvider(env.SHIPPING_PROVIDER);
}
