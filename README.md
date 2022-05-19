# tronscan-transfers-downloader
Node.js script to download all TRX, TRC10 and TRC20 transfers to/from an account to a CSV file, using Tronscan APIs.
Confer also https://github.com/tronscan/tronscan-frontend/blob/dev2019/document/api.md and https://github.com/tronprotocol/documentation/blob/master/English_Documentation/TRON_Virtual_Machine/TRC10_TRX_TRANSFER_INTRODUCTION_FOR_EXCHANGES.md.

## Prerequisites
* [Node.js](https://nodejs.org/en/download/package-manager/) – version 10 or above is **required**
* [Yarn](https://yarnpkg.com/en/docs/install) – recommend latest stable version

## Usage
```bash
yarn
yarn start <tron-address> <output-csv-file>
```
