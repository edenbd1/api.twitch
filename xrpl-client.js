const xrpl = require('xrpl');

// Configuration
const RLUSD_CURRENCY_HEX = "524C555344000000000000000000000000000000"; // RLUSD en hexadécimal
const RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV"; // Adresse de l'émetteur RLUSD
const ADMIN_WALLET_SEED = process.env.ADMIN_WALLET_SEED; // Seed du wallet admin pour le funding

// Fonction pour obtenir un client XRPL connecté
async function getClient() {
    const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
    await client.connect();
    return client;
}

// Fonction pour attendre la validation d'une transaction
async function waitForValidation(client, hash) {
    return new Promise((resolve, reject) => {
        const checkInterval = setInterval(async () => {
            try {
                const tx = await client.request({
                    command: "tx",
                    transaction: hash
                });
                if (tx.result.validated) {
                    clearInterval(checkInterval);
                    resolve(tx);
                }
            } catch (error) {
                clearInterval(checkInterval);
                reject(error);
            }
        }, 1000);
    });
}

// Fonction pour configurer un nouveau wallet
async function configureWallet(seed) {
    let xrplClient;
    try {
        console.log('Démarrage de la configuration du wallet...');
        console.log('Seed reçu:', seed);

        // Connexion au client XRPL
        console.log('Connexion au client XRPL...');
        xrplClient = await getClient();
        console.log('Client XRPL connecté');

        // Charger le wallet
        console.log('Chargement du wallet...');
        const wallet = xrpl.Wallet.fromSeed(seed);
        console.log(`Wallet chargé: ${wallet.address}`);

        // 1. Activer DEFAULT_RIPPLE
        console.log('Préparation de la transaction DEFAULT_RIPPLE...');
        const accountSetTx = await xrplClient.autofill({
            TransactionType: "AccountSet",
            Account: wallet.address,
            SetFlag: 8 // asfDefaultRipple
        });
        console.log('Transaction DEFAULT_RIPPLE préparée');
        
        console.log('Signature de la transaction DEFAULT_RIPPLE...');
        const accountSetTxSigned = wallet.sign(accountSetTx);
        console.log('Transaction DEFAULT_RIPPLE signée');

        console.log('Soumission de la transaction DEFAULT_RIPPLE...');
        const accountSetResult = await xrplClient.submitAndWait(accountSetTxSigned.tx_blob);
        console.log(`DEFAULT_RIPPLE activé! Hash: ${accountSetResult.result.hash}`);

        // 2. Configurer la trustline RLUSD
        console.log('Préparation de la transaction Trustline...');
        const trustSetTx = await xrplClient.autofill({
            TransactionType: "TrustSet",
            Account: wallet.address,
            LimitAmount: {
                currency: RLUSD_CURRENCY_HEX,
                issuer: RLUSD_ISSUER,
                value: "1000000"
            }
        });
        console.log('Transaction Trustline préparée');

        console.log('Signature de la transaction Trustline...');
        const trustSetTxSigned = wallet.sign(trustSetTx);
        console.log('Transaction Trustline signée');

        console.log('Soumission de la transaction Trustline...');
        const trustSetResult = await xrplClient.submitAndWait(trustSetTxSigned.tx_blob);
        console.log(`Trustline configurée! Hash: ${trustSetResult.result.hash}`);

        // Vérifier le solde final
        console.log('Vérification du solde final...');
        const balanceResponse = await xrplClient.request({
            command: "account_info",
            account: wallet.address,
            ledger_index: "validated"
        });

        const xrpBalance = xrpl.dropsToXrp(balanceResponse.result.account_data.Balance);
        console.log(`Solde final: ${xrpBalance} XRP`);

        return {
            success: true,
            address: wallet.address,
            xrpBalance: xrpBalance,
            transactions: {
                defaultRipple: accountSetResult.result.hash,
                trustline: trustSetResult.result.hash
            }
        };

    } catch (error) {
        console.error('Erreur détaillée lors de la configuration:');
        console.error('Message:', error.message);
        if (error.data) {
            console.error('Données d\'erreur:', JSON.stringify(error.data, null, 2));
        }
        if (error.stack) {
            console.error('Stack trace:', error.stack);
        }
        throw error;
    } finally {
        if (xrplClient) {
            console.log('Déconnexion du client XRPL...');
            xrplClient.disconnect();
        }
    }
}

module.exports = {
    getClient,
    waitForValidation,
    configureWallet,
    RLUSD_CURRENCY_HEX,
    RLUSD_ISSUER
}; 