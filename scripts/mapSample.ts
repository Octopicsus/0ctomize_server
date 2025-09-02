import { __test } from "../src/api/bankImport";

const sample = {
  transactions: {
    booked: [
      {
        transactionId: "68a1af3a-30f5-a59c-8e29-144c7b7bfeb4",
        bookingDate: "2025-08-17",
        valueDate: "2025-08-18",
        bookingDateTime: "2025-08-17T10:30:18.489766Z",
        valueDateTime: "2025-08-18T04:43:34.536646Z",
        transactionAmount: { amount: "-27.00", currency: "CZK" },
        creditorName: "Relay Quadrio 31054",
        remittanceInformationUnstructuredArray: ["Relay Quadrio 31054"],
        proprietaryBankTransactionCode: "CARD_PAYMENT"
      },
      {
        transactionId: "68a1ac02-b931-ab9e-bd18-e4a377a6268f",
        bookingDate: "2025-08-17",
        valueDate: "2025-08-18",
        bookingDateTime: "2025-08-17T10:16:34.152427Z",
        valueDateTime: "2025-08-18T04:43:37.182952Z",
        transactionAmount: { amount: "-158.00", currency: "CZK" },
        creditorName: "Paul-quadrio - Kiosk 6",
        remittanceInformationUnstructuredArray: ["Paul-Quadrio - Kiosk 6"],
        proprietaryBankTransactionCode: "CARD_PAYMENT"
      }
    ]
  }
};

const docs = sample.transactions.booked.map((tx) =>
  __test.mapGCToTransaction("user1", "user1@example.com", "acc1", tx)
);

console.log(JSON.stringify(docs, null, 2));
