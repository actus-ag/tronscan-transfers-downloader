const rpn = require('request-promise-native')
const stringify = require('csv-stringify/lib/sync')
const csv = require('csv-parser')
const fsPromises = require('fs').promises
const fs = require('fs')
const Store = require('server-store')
const ramda = require('ramda')

// import the cond function
const { curry, always, juxt, cond, equals, T } = ramda

const trc20DetailsCache = new Store(
  'tronscanTransfersDownloader',
  'trc20DetailsCache',
  '/tmp/store',
  259200000, // 72h
  80000000 // 80MB
)

const cryptioAssetsDefinitionFile = 'cryptio_supported_assets_2022_05_19.csv'

if (process.argv.length < 3) {
  console.error('Usage: node index.js TRON-ADDRESS [output.csv]')
  process.exit(0)
}
const address = process.argv[2]
let outputFile = 'output.csv'
if (process.argv.length >= 4) {
  outputFile = process.argv[3]
}

function insert_decimal_point(amount, decimals) {
  amount = amount.toString()
  if (!decimals) {
    return amount
  }
  if (amount.length <= decimals) {
    return '0.' + '0'.repeat(decimals - amount.length) + amount
  }
  return (
    amount.slice(0, amount.length - decimals) +
    '.' +
    amount.slice(amount.length - decimals)
  )
}

let cryptioAssets = []

async function getCryptioAssets() {
  console.log('Loading assets supported by cryptio...')

  await new Promise((resolve, _) => {
    fs.createReadStream(cryptioAssetsDefinitionFile)
      .pipe(csv())
      .on('data', (data) => cryptioAssets.push(data))
      .on('end', () => {
        resolve()
      })
  })
}

let trc10_cache = {}

async function get_trc10_details(id) {
  if (trc10_cache[id]) {
    return trc10_cache[id]
  }
  let options = {
    uri: 'https://apilist.tronscan.org/api/token',
    qs: {
      id,
      showAll: 1,
    },
    headers: {
      'User-Agent': 'Request-Promise-Native',
    },
    json: true,
  }
  let reply = await rpn(options)
  if (!reply.data.length) {
    throw new Error("Couldn't retrieve information for TRC10 ID " + id)
  }
  trc10_cache[id] = reply.data[0]
  return trc10_cache[id]
}

let trc20_details

async function download_trc20_details() {
  trc20_details = trc20DetailsCache.getItem('trc20Details')
  if (trc20_details === undefined) {
    trc20_details = {}
    let downloaded = 0
    let options = {
      uri: 'https://apilist.tronscan.org/api/token_trc20',
      qs: {
        limit: 50,
        start: 0,
      },
      headers: {
        'User-Agent': 'Request-Promise-Native',
      },
      json: true,
    }
    let reply = await rpn(options)
    let total = reply.rangeTotal
    while (downloaded < total) {
      reply = await rpn(options)
      for (let i = 0; i < reply.trc20_tokens.length; ++i) {
        trc20_details[reply.trc20_tokens[i].name] = reply.trc20_tokens[i]
      }
      downloaded += reply.trc20_tokens.length
      console.log('Downloaded ' + downloaded + '/' + total)
      options.qs.start += reply.trc20_tokens.length
    }
    trc20DetailsCache.setItem('trc20Details', trc20_details)
  } else {
    console.log('Using cached TRC20 token data.')
  }
}

async function download_transfers(uri, transfer_processor) {
  let transfers = []
  let options = {
    uri,
    qs: {
      address,
      limit: 50,
      start: 0,
    },
    headers: {
      'User-Agent': 'Request-Promise-Native',
    },
    json: true,
  }
  let reply = await rpn(options)
  let total = reply.rangeTotal
  while (transfers.length < total) {
    for (let i = 0; i < reply.data.length; ++i) {
      transfers.push(await transfer_processor(reply.data[i]))
    }
    console.log('Downloaded ' + transfers.length + '/' + total)
    options.qs.start += reply.data.length
    reply = await rpn(options)
  }
  return transfers
}

function getDateTimeStringFrom(timestamp) {
  const date = new Date(timestamp)
  const padN = curry((padding, number) =>
    number.toString().padStart(padding, '0')
  )
  const pad2 = padN(2)
  const year = padN(4)(date.getFullYear())
  const month = pad2(date.getMonth() + 1)
  const day = pad2(date.getDate())
  const hour = pad2(date.getHours())
  const minutes = pad2(date.getMinutes())
  return `${year}-${month}-${day} ${hour}:${minutes}`
}

function isIncomingTransaction(transaction) {
  return equals(address, transaction.transferToAddress)
}

function isOutgoingTransaction(transaction) {
  return equals(address, transaction.transferFromAddress)
}

function getAmountFrom(transaction) {
  return insert_decimal_point(transaction.amount, transaction.decimals)
}

function getCsvHeaderRow() {
  return [
    'transactionDate',
    'orderType',
    'txhash',
    'incomingAsset',
    'incomingVolume',
    'outgoingAsset',
    'outgoingVolume',
    'feeAsset',
    'feeVolume',
    'otherParties',
    'note',
    'success',
    'internalTransfer',
  ]
}

function getCryptioUniqueAssetId(transaction) {
  const cryptioAsset = cryptioAssets.find(
    (cryptioAsset) =>
      equals(cryptioAsset.name, transaction.tokenName) ||
      equals(cryptioAsset.name, transaction.fullTokenName) ||
      equals(cryptioAsset.symbol, transaction.tokenAbbr)
  )
  if (cryptioAsset === undefined) {
    // cryptio does not recognize this token
    console.log(
      `Warning: cryptio does not recognize the token ${transaction.tokenName} (${transaction.tokenAbbr})`
    )
    // TODO
    return transaction.tokenAbbr
  } else {
    return cryptioAsset.unique_symbol
  }
}

function getCsvRowFrom(transaction) {
  const transactionDate = (transaction) =>
    getDateTimeStringFrom(transaction.timestamp)
  const orderType = cond([
    [isIncomingTransaction, always('deposit')],
    [isOutgoingTransaction, always('withdraw')],
    // TODO: cryptio orderType: 'transfer'
    [T, always('')],
  ])
  const txhash = (transaction) => transaction.transactionHash
  const incomingAsset = cond([
    [isIncomingTransaction, getCryptioUniqueAssetId],
    [T, always('')],
  ])
  const incomingVolume = cond([
    [isIncomingTransaction, (transaction) => getAmountFrom(transaction)],
    [T, always('')],
  ])
  const outgoingAsset = cond([
    [isOutgoingTransaction, getCryptioUniqueAssetId],
    [T, always('')],
  ])
  const outgoingVolume = cond([
    [isOutgoingTransaction, (transaction) => getAmountFrom(transaction)],
    [T, always('')],
  ])
  // tron transfers are virtually free, so we ignore the fees
  const feeAsset = always('')
  const feeVolume = always('')
  const otherParties = cond([
    [isIncomingTransaction, (transaction) => transaction.transferFromAddress],
    [isOutgoingTransaction, (transaction) => transaction.transferToAddress],
    [T, always('')],
  ])
  const note = always('')
  const success = (transaction) =>
    !transaction.revert && transaction.confirmed ? '1' : '0'
  const internalTransfer = always('')

  return juxt([
    transactionDate,
    orderType,
    txhash,
    incomingAsset,
    incomingVolume,
    outgoingAsset,
    outgoingVolume,
    feeAsset,
    feeVolume,
    otherParties,
    note,
    success,
    internalTransfer,
  ])(transaction)
}

async function main() {
  await getCryptioAssets()

  console.log('Downloading details of TRC20 tokens...')
  await download_trc20_details()

  let record_sets = []
  console.log('Downloading TRX/TRC10 transfers...')
  record_sets.push(
    await download_transfers(
      'https://apilist.tronscan.org/api/transfer',
      async function (transfer) {
        if (transfer.tokenName == '_') {
          transfer.decimals = 6
          transfer.tokenAbbr = 'TRX'
          transfer.tokenFullName = 'Tronix'
        } else {
          let token_details = await get_trc10_details(transfer.tokenName)
          transfer.decimals = token_details.precision
          transfer.tokenAbbr = token_details.abbr
          transfer.tokenFullName = token_details.name
        }
        return transfer
      }
    )
  )

  console.log('Downloading TRC20 transfers...')
  record_sets.push(
    await download_transfers(
      'https://apilist.tronscan.org/api/contract/events',
      async function (transfer) {
        transfer.tokenAbbr = trc20_details[transfer.tokenName]
          ? trc20_details[transfer.tokenName].symbol
          : ''
        transfer.tokenFullName = transfer.tokenName
        return transfer
      }
    )
  )

  let csvFile
  try {
    csvFile = await fsPromises.open(outputFile, 'w')
    console.log('Writing to file ' + outputFile + '...')
    await csvFile.write(stringify([getCsvHeaderRow()]))
    while (record_sets.length) {
      let max_timestamp = 0
      let max_timestamp_index
      for (let i = 0; i < record_sets.length; ++i) {
        if (record_sets[i][0].timestamp > max_timestamp) {
          max_timestamp = record_sets[i][0].timestamp
          max_timestamp_index = i
        }
      }
      let record = record_sets[max_timestamp_index].shift()
      if (!record_sets[max_timestamp_index].length) {
        record_sets.splice(max_timestamp_index, 1)
      }
      await csvFile.write(stringify([getCsvRowFrom(record)]))
    }
    console.log('Successfully written all records to ' + outputFile + '!')
  } finally {
    if (csvFile !== undefined) {
      await csvFile.close()
    }
  }
}

main().catch(function (err) {
  console.error(err)
  process.exit(1)
})
