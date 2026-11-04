export const TERMS_VERSION = "2026-10-15";

export const TERMS_TEXT = `IMPORTANT NOTICE, DISCLAIMER AND TERMS OF USE (version ${TERMS_VERSION})

Read this before continuing. By accepting you confirm that you are an adult who has the legal capacity and the right to use this service in your jurisdiction.

1. NO ADVICE. This service is a software tool. It is not financial, investment, legal or tax advice. You are solely responsible for your decisions and for complying with the laws that apply to you.

2. HIGH RISK. Digital assets are volatile and you can lose all or part of the value you commit. Past or modelled results do not guarantee future results.

3. LOAN TERMS. One fixed loan of 1000 USDC for a single term of 6 weeks (42 days), with no extension. The borrower pays a 2.5% issuance fee to the house and 12% annual interest prorated over 42 days. Collateral is cirBTC only (Circle's natively issued bitcoin token on Arc) at a 25% loan-to-value ratio.

4. BORROWER. If you do not repay principal plus interest at the end of the term, your collateral is sold on-chain for USDC by the LoanEscrow smart contract. Any proceeds above the amount owed to the lender are kept by the house, and you receive nothing back. You may lose your entire collateral.

5. LENDER. Lenders are served in first-in, first-out (FIFO) order. The lender is expected to receive principal plus interest, either from the borrower or from the on-chain sale of the collateral, with any shortfall covered by the house. The house's ability to cover a shortfall is not guaranteed and is not a deposit, an insurance product or a government-backed guarantee.

6. NON-CUSTODIAL. This service never holds your funds, keys, seed or secrets, and it never asks for them. Never send any. You sign every transaction yourself in your own wallet. Collateral is held only by the audited LoanEscrow smart contract, never by an operator-controlled account, and settlement at maturity is a permissionless on-chain call anyone can trigger -- no operator key ever custodies loan funds. Blockchain transactions are final and cannot be reversed.

7. NO WARRANTY. The service is provided "as is" and "as available", without warranties of any kind, express or implied, including accuracy, availability, uninterrupted operation or fitness for a purpose. Prices and time come from third-party Arc network nodes and on-chain price sources that can be wrong, delayed or unavailable.

8. LIMITATION OF LIABILITY. To the maximum extent permitted by law, the operator is not liable for indirect, incidental or consequential losses, lost profits, market movements, network failures, wallet or user errors, smart contract risk, or the actions of third parties.

9. ELIGIBILITY AND COMPLIANCE. You must not use the service where it is prohibited or from a sanctioned jurisdiction, and you must not use it for unlawful activity.

10. PRIVACY. Requests are processed in memory and cleared when the connection closes. IP addresses are kept only as keyed fingerprints for the 24-hour per-IP limit.

11. CHANGES. The operator may change or suspend the service at any time without notice. These terms are a template for review by your own legal counsel and are not a substitute for legal advice.`;

export const ACCEPT_PHRASE = "I ACCEPT";

export function termsAccepted(body) {
  const a = body?.acceptedTerms;
  return Boolean(a) && a.version === TERMS_VERSION && a.lender === true && a.borrower === true;
}
