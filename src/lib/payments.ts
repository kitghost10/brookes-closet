import { env } from "./env";
import type { Queryable } from "./db";

export type CheckoutInput = {
  sessionId: string;
  userId: string;
  kind: "package" | "plan";
  itemName: string;
  amountCents: number;
  currency: string;
};

/**
 * Payment-provider adapter. Real providers (hosted checkout pages + signed webhooks) implement this
 * and call `fulfillCheckout` from the webhook handler. The app NEVER sees or stores card data.
 * No real provider is implemented: choose one that explicitly permits this business first.
 */
export interface PaymentProvider {
  readonly id: string;
  readonly isSimulation: boolean;
  createCheckout(input: CheckoutInput): Promise<{ checkoutUrl: string; providerRef: string }>;
  cancelSubscription(providerRef: string | null): Promise<void>;
  refund(providerRef: string | null, amountCents: number): Promise<void>;
}

export class ProviderUnavailableError extends Error {}

class DevSimulationProvider implements PaymentProvider {
  readonly id = "dev_simulation";
  readonly isSimulation = true;
  async createCheckout(i: CheckoutInput) {
    if (env.isProd) throw new ProviderUnavailableError("Development checkout simulation is disabled in production");
    return { checkoutUrl: `/checkout/dev/${i.sessionId}`, providerRef: `sim_${i.sessionId}` };
  }
  async cancelSubscription() { /* nothing external to cancel */ }
  async refund() { /* nothing external to refund */ }
}

class DisabledProvider implements PaymentProvider {
  readonly id = "none";
  readonly isSimulation = false;
  async createCheckout(): Promise<never> { throw new ProviderUnavailableError("Payments are not enabled yet"); }
  async cancelSubscription() {}
  async refund(): Promise<never> { throw new ProviderUnavailableError("No payment provider configured"); }
}

export function getPaymentProvider(): PaymentProvider {
  switch (env.paymentsProvider) {
    case "dev_simulation": return env.isProd ? new DisabledProvider() : new DevSimulationProvider();
    case "none": return new DisabledProvider();
    default: throw new Error(`PAYMENTS_PROVIDER="${env.paymentsProvider}" has no adapter. See docs/PROVIDERS.md.`);
  }
}

export type { Queryable };
