const fs = require('fs');
const Web3 = require('web3');
const axios = require('axios');

const RPC_URL = 'https://testnet.dplabs-internal.com';
const CHAIN_ID = 688688;

const PHAROSWAP_ROUTER = '0x3541423f25a1ca5c98fdbcf478405d3f0aad1164';
const WETH_CONTRACT = '0x76aaaDA469D23216bE5f7C596fA25F282Ff9b364';

const STABLE_COINS = {
  USDC: '0x72df0bcd7276f2dFbAc900D1CE63c272C4BCcCED',
  USDT: '0xD4071393f8716661958F766DF660033b3d35fD29'
};

const DAILY_RUN_INTERVAL = 24 * 60 * 60 * 1000;
const MIN_TX_DELAY = 1 * 60 * 1000;
const MAX_TX_DELAY = 3 * 60 * 1000;

// User-configurable swap amount range (in tokens)
const SWAP_MIN_AMOUNT = 0.1;
const SWAP_MAX_AMOUNT = 1.0;

let cycleStartTime = null;

const commonHeaders = {
  'accept': 'application/json, text/plain, */*',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'accept-language': 'en-GB,en;q=0.6',
  'origin': 'https://testnet.pharosnetwork.xyz',
  'referer': 'https://testnet.pharosnetwork.xyz/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
};

const web3 = new Web3(RPC_URL);

function showWelcomeBox() {
  console.log("\n===============================");
  console.log("        PHAROS AUTO BOT       ");
  console.log("     Stablecoin Swap Edition  ");
  console.log("===============================\n");
  console.log(`💰 Swap range: ${SWAP_MIN_AMOUNT} – ${SWAP_MAX_AMOUNT} token`);
}

function formatTime(ms) {
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric',
    minute: '2-digit', second: '2-digit', hour12: true
  });
}

function getRandomTxDelay() {
  const delay = Math.floor(Math.random() * (MAX_TX_DELAY - MIN_TX_DELAY + 1)) + MIN_TX_DELAY;
  console.log(`⏳ Waiting ${(delay / 60000).toFixed(1)} minutes before next transaction...`);
  return delay;
}

function randomDelay(min = 10000, max = 20000) {
  const delayMs = Math.floor(Math.random() * (max - min + 1)) + min;
  console.log(`\n⌛ Next wallet delay: ${(delayMs / 1000).toFixed(1)}s`);
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function withRetry(fn, maxRetries = 5, backoffBase = 5000) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      const delayMs = backoffBase * Math.pow(2, attempt);
      console.log(`Retrying in ${(delayMs / 1000).toFixed(1)}s... (Attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      attempt++;
    }
  }
}

function readPrivateKeys() {
  const keys = fs.readFileSync('privatekeys.txt', 'utf-8')
    .split('\n')
    .map(pk => pk.trim())
    .filter(pk => pk !== '');
  console.log(`\n📂 Loaded ${keys.length} wallet${keys.length !== 1 ? 's' : ''}`);
  return keys;
}

async function loginUser(privateKey) {
  const account = web3.eth.accounts.privateKeyToAccount(privateKey);
  const signature = account.sign('pharos').signature;
  const response = await axios.post(
    `https://api.pharosnetwork.xyz/user/login?address=${account.address}&signature=${signature}`,
    null,
    { headers: { ...commonHeaders, 'authorization': 'Bearer null', 'content-length': '0' } }
  );
  if (response.data.code !== 0) throw new Error(`Login failed: ${response.data.msg}`);
  const jwt = response.data.data?.jwt || response.data.jwt;
  if (!jwt) throw new Error('JWT token not found');
  return { address: account.address, token: jwt };
}

async function checkInUser(address, token) {
  const response = await axios.post(
    `https://api.pharosnetwork.xyz/sign/in?address=${address}`,
    address,
    {
      headers: {
        ...commonHeaders,
        'authorization': `Bearer ${token}`,
        'content-type': 'text/plain'
      }
    }
  );
  if (response.data.code === 0) console.log('✅ Daily check-in successful!');
  else if (response.data.code === 1) console.log('⏩ Already checked in today');
  else throw new Error(`Check-in failed: ${response.data.msg}`);
}

async function performPharoswapSwap(privateKey, walletAddress, txIndex) {
  const account = web3.eth.accounts.privateKeyToAccount(privateKey);
  web3.eth.accounts.wallet.add(account);

  try {
    const isUsdcToUsdt = txIndex % 2 === 0;
    const fromToken = isUsdcToUsdt ? STABLE_COINS.USDC : STABLE_COINS.USDT;
    const toToken = isUsdcToUsdt ? STABLE_COINS.USDT : STABLE_COINS.USDC;

    const erc20Abi = [
      { constant: true, inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], name: 'allowance', outputs: [{ name: '', type: 'uint256' }], type: 'function' },
      { constant: true, inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], type: 'function' },
      { constant: true, inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], type: 'function' },
      { constant: false, inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'approve', outputs: [{ name: '', type: 'bool' }], type: 'function' }
    ];

    const fromTokenContract = new web3.eth.Contract(erc20Abi, fromToken);
    const tokenBalance = await fromTokenContract.methods.balanceOf(walletAddress).call();
    const tokenBalanceBN = web3.utils.toBN(tokenBalance);

    const rawAmount = Math.random() * (SWAP_MAX_AMOUNT - SWAP_MIN_AMOUNT) + SWAP_MIN_AMOUNT;
    if (rawAmount <= 0) {
      console.log(`⚠️ Invalid amount generated: ${rawAmount.toFixed(6)}`);
      return;
    }

    const amountIn = web3.utils.toBN(web3.utils.toWei(rawAmount.toFixed(6)));
    if (tokenBalanceBN.lt(amountIn)) {
      console.log(`⚠️ Skip swap, balance too low. Required: ${rawAmount.toFixed(6)}`);
      return;
    }

    const allowance = await fromTokenContract.methods.allowance(walletAddress, PHAROSWAP_ROUTER).call();
    if (web3.utils.toBN(allowance).lt(amountIn)) {
      const approveTx = fromTokenContract.methods.approve(PHAROSWAP_ROUTER, web3.utils.toHex(amountIn));
      const gas = await approveTx.estimateGas({ from: walletAddress });
      const gasPrice = await web3.eth.getGasPrice();
      const txData = {
        from: walletAddress,
        to: fromToken,
        data: approveTx.encodeABI(),
        gas,
        gasPrice,
        nonce: await web3.eth.getTransactionCount(walletAddress, 'pending'),
        chainId: CHAIN_ID
      };
      const signed = await web3.eth.accounts.signTransaction(txData, privateKey);
      const approveReceipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);
      console.log(`✅ Approved ${isUsdcToUsdt ? 'USDC' : 'USDT'}: TX ${approveReceipt.transactionHash}`);
    }

    const deadline = Math.floor(Date.now() / 1000) + 600;
    const swapData = web3.eth.abi.encodeFunctionCall({
      name: 'swapExactTokensForTokens',
      type: 'function',
      inputs: [
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMin', type: 'uint256' },
        { name: 'path', type: 'address[]' },
        { name: 'to', type: 'address' },
        { name: 'deadline', type: 'uint256' }
      ]
    }, [
      amountIn.toString(),
      '0',
      [fromToken, toToken],
      walletAddress,
      deadline
    ]);

    const gasPrice = await web3.eth.getGasPrice();
    const tx = {
      from: walletAddress,
      to: PHAROSWAP_ROUTER,
      data: swapData,
      gasPrice,
      nonce: await web3.eth.getTransactionCount(walletAddress, 'pending'),
      chainId: CHAIN_ID
    };

    const estimatedGas = await web3.eth.estimateGas(tx);
    tx.gas = Math.floor(estimatedGas * 1.2);

    const signedTx = await web3.eth.accounts.signTransaction(tx, privateKey);
    const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);

    console.log(`✅ TX #${txIndex + 1}: Swapped ${rawAmount.toFixed(6)} ${isUsdcToUsdt ? 'USDC → USDT' : 'USDT → USDC'} | TX: ${receipt.transactionHash}`);
  } catch (e) {
    console.error(`❌ TX #${txIndex + 1} swap error:`, e.message);
  } finally {
    web3.eth.accounts.wallet.remove(account.address);
  }
}

async function processWallet(privateKey, index, total) {
  console.log(`\n══════════ Wallet ${index + 1}/${total} ══════════`);
  try {
    const { address, token } = await withRetry(() => loginUser(privateKey));
    await withRetry(() => checkInUser(address, token), 5);
    for (let i = 0; i < 10; i++) {
      await withRetry(() => performPharoswapSwap(privateKey, address, i), 3);
      await new Promise(resolve => setTimeout(resolve, getRandomTxDelay()));
    }
    return { success: true };
  } catch (err) {
    console.error('⚠️ Wallet error:', err.message);
    return { success: false };
  }
}

async function main() {
  showWelcomeBox();
  if (!cycleStartTime) cycleStartTime = Date.now();
  const privateKeys = readPrivateKeys();
  let successCount = 0;
  for (let i = 0; i < privateKeys.length; i++) {
    const result = await processWallet(privateKeys[i], i, privateKeys.length);
    if (result.success) successCount++;
    if (i < privateKeys.length - 1) await randomDelay();
  }
  console.log(`\n✅ ${successCount}/${privateKeys.length} wallets completed successfully.`);
  scheduleNextRun();
}

function scheduleNextRun() {
  const nextRunMs = cycleStartTime + DAILY_RUN_INTERVAL;
  console.log(`\n⏰ Next run scheduled at: ${formatTime(nextRunMs)}`);
  setTimeout(main, Math.max(nextRunMs - Date.now(), 0));
}

process.on('SIGINT', () => {
  console.log('\n🛑 Script terminated.');
  process.exit();
});

main().catch(err => {
  console.error('🚨 Fatal Error:', err);
  process.exit(1);
});
