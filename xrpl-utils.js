const xrpl = require('xrpl');
const crypto = require('crypto');

// Configuration XRPL
const ADMIN_WALLET_SEED = process.env.XRPL_HOT_WALLET_SEED;
const RLUSD_ISSUER = process.env.XRPL_RLUSD_ISSUER;
const RLUSD_CURRENCY = process.env.XRPL_RLUSD_CURRENCY;
const RLUSD_CURRENCY_HEX = process.env.XRPL_RLUSD_CURRENCY_HEX;

// Fonction pour créer un nouveau wallet
async function createWallet() {
    const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
    await client.connect();
    
    const fund_result = await client.fundWallet();
    const wallet = fund_result.wallet;
    
    await client.disconnect();
    return wallet;
}

// Fonction pour chiffrer la clé privée
function encryptPrivateKey(privateKey, password) {
    const key = crypto.scryptSync(password, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(privateKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return {
        iv: iv.toString('hex'),
        encryptedData: encrypted
    };
}

// Fonction pour déchiffrer la clé privée
function decryptPrivateKey(encryptedData, iv, password) {
    const key = crypto.scryptSync(password, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// Fonction pour financer un wallet
async function fundWallet(address) {
    const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
    await client.connect();
    
    const adminWallet = xrpl.Wallet.fromSeed(ADMIN_WALLET_SEED);
    
    const payment = {
        TransactionType: "Payment",
        Account: adminWallet.address,
        Destination: address,
        Amount: xrpl.xrpToDrops("1.21")
    };
    
    const prepared = await client.autofill(payment);
    const signed = adminWallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);
    
    await client.disconnect();
    return result;
}

// Fonction pour activer DefaultRipple
async function enableDefaultRipple(seed) {
    const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
    await client.connect();
    
    const wallet = xrpl.Wallet.fromSeed(seed);
    
    const settings = {
        TransactionType: "AccountSet",
        Account: wallet.address,
        SetFlag: xrpl.AccountSetAsfFlags.asfDefaultRipple
    };
    
    const prepared = await client.autofill(settings);
    const signed = wallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);
    
    await client.disconnect();
    return result;
}

// Fonction pour configurer la trustline RLUSD
async function setupRLUSDTrustline(seed) {
    const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
    await client.connect();
    
    const wallet = xrpl.Wallet.fromSeed(seed);
    
    const trustline = {
        TransactionType: "TrustSet",
        Account: wallet.address,
        LimitAmount: {
            currency: RLUSD_CURRENCY_HEX,
            issuer: RLUSD_ISSUER,
            value: "1000000"
        }
    };
    
    const prepared = await client.autofill(trustline);
    const signed = wallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);
    
    await client.disconnect();
    return result;
}

module.exports = {
    createWallet,
    encryptPrivateKey,
    decryptPrivateKey,
    fundWallet,
    enableDefaultRipple,
    setupRLUSDTrustline
}; 