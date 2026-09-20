export class PaymentProvider {
  async findCustomerByExternalReference() { return null; }
  async createOrFindCustomer() { throw new Error('PAYMENT_PROVIDER_NOT_IMPLEMENTED'); }
  async findPixChargeByExternalReference() { return null; }
  async createPixCharge() { throw new Error('PAYMENT_PROVIDER_NOT_IMPLEMENTED'); }
  async getPixQrCode() { throw new Error('PAYMENT_PROVIDER_NOT_IMPLEMENTED'); }
  async getPayment() { throw new Error('PAYMENT_PROVIDER_NOT_IMPLEMENTED'); }
  async cancelPayment() { throw new Error('PAYMENT_PROVIDER_NOT_IMPLEMENTED'); }
  validateWebhook() { throw new Error('PAYMENT_PROVIDER_NOT_IMPLEMENTED'); }
  async getProviderBalance() { return null; }
  async requestRefund() { throw new Error('PAYMENT_PROVIDER_NOT_IMPLEMENTED'); }
  async requestPixTransfer() { throw new Error('AUTO_WITHDRAWALS_DISABLED'); }
  async getTransfer() { throw new Error('AUTO_WITHDRAWALS_DISABLED'); }
}

export default PaymentProvider;
