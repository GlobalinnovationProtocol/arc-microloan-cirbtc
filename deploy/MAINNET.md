# Arc Mainnet deployment configuration

Arc Mainnet settings are in `src/params.js`: RPC URL, chain ID `5042`, explorer
URL, and Circle's USDC ERC-20 address. `ARC_RPC_URL` can override the default.
At startup the server checks the RPC-reported chain ID and exits if it is not
Arc Mainnet.

## Ubuntu service configuration

From the deployed project directory (default `/opt/d-kyc`):

```bash
cd /opt/d-kyc
sudo install -d -m 0750 /etc/d-kyc
sudo cp deploy/d-kyc.service /etc/systemd/system/d-kyc.service
sudo install -m 0600 /dev/null /etc/d-kyc/d-kyc.env
sudo nano /etc/d-kyc/d-kyc.env
```

Enter the company's Arc Mainnet house address and RPC URL in
`/etc/d-kyc/d-kyc.env`:

```ini
HOUSE_ADDRESS=REPLACE_WITH_COMPANY_ARC_MAINNET_ADDRESS
ARC_RPC_URL=https://rpc.mainnet.arc.io
```

If using Circle's public RPC, keep the URL as shown. If using a provider URL
with an API key, use that provider's Arc Mainnet URL and keep this file at mode
`0600`. Do not place private keys in this file.

The service reads the address allowlist from `/etc/d-kyc/kyc-approved.txt`.
Create it with one approved EVM address per line:

```bash
sudo install -m 0640 /dev/null /etc/d-kyc/kyc-approved.txt
sudo nano /etc/d-kyc/kyc-approved.txt
sudo chown root:root /etc/d-kyc/d-kyc.env /etc/d-kyc/kyc-approved.txt
sudo chmod 0600 /etc/d-kyc/d-kyc.env
sudo chmod 0640 /etc/d-kyc/kyc-approved.txt
```

Optional settlement automation uses a keeper private key. It is not required
for the service to start; without it, settlement must be triggered manually.
To enable it, create `/etc/d-kyc/keeper.env` with one line,
`KEEPER_PRIVATE_KEY=0x...`, and restrict it:

```bash
sudo install -m 0600 /dev/null /etc/d-kyc/keeper.env
sudo nano /etc/d-kyc/keeper.env
sudo chown root:root /etc/d-kyc/keeper.env
sudo chmod 0600 /etc/d-kyc/keeper.env
```

Do not fund the keeper with loan collateral or house reserves.

Start the service and inspect it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now d-kyc
sudo systemctl status d-kyc --no-pager
sudo journalctl -u d-kyc -n 100 --no-pager
curl --fail http://127.0.0.1:8080/health
curl --fail http://127.0.0.1:8080/terms
```

## Values still required before live loans

The server is not configured for functional mainnet loans until all of these are
verified and set in `src/params.js`: Arc contract addresses and decimals for
cirBTC (Circle's native bitcoin token on Arc, env `CIRBTC_ADDRESS` / `CIRBTC_DECIMALS`); a DEX router and route for cirBTC/USDC;
and a live price source implementation for cirBTC. The
`LoanEscrow` address must be populated after contract deployment. The source
currently has no live price-source implementation and these values remain
blank; the external auditor should review that state as an unresolved
integration requirement, not as an enabled production product.

Do not deploy `LoanEscrow` to Arc Mainnet until its constructor values, token
contracts, DEX router behavior, and collateral-to-USDC pricing/liquidity have
been verified for Arc Mainnet.
