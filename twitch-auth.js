const express = require('express');
const axios = require('axios');
const path = require('path');
const mongoose = require('mongoose');
const config = require('./config');
const Streamer = require('./models/Streamer');
const xrpl = require('xrpl');
require('dotenv').config();

const app = express();
const port = 3000;

// Constantes XRPL
const RLUSD_CURRENCY_HEX = process.env.XRPL_RLUSD_CURRENCY_HEX;
const RLUSD_ISSUER = process.env.XRPL_RLUSD_ISSUER;
const INITIAL_FUNDING_XRP = 1.2; // Montant initial en XRP pour les nouveaux wallets

// Fonction utilitaire pour attendre la validation d'une transaction XRPL
async function waitForValidation(client, hash) {
    return new Promise((resolve, reject) => {
        const interval = setInterval(async () => {
            try {
                const tx = await client.request({ command: "tx", transaction: hash });
                if (tx.result.validated) {
                    clearInterval(interval);
                    resolve(tx);
                }
            } catch (e) {
                clearInterval(interval);
                reject(e);
            }
        }, 1000); // Vérifie toutes les secondes
    });
}

// Fonction pour générer la page de bienvenue avec les clés
function generateWelcomePageHtml(displayName, publicKey, privateKey) {
    return `
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Bienvenue</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                    background-color: #18181b;
                    color: white;
                }
                .container {
                    text-align: center;
                    padding: 2rem;
                    background-color: #1f1f23;
                    border-radius: 8px;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    width: 100%;
                    max-width: 500px;
                }
                .welcome-message {
                    color: #00ff00;
                    margin: 20px 0;
                }
                .back-button {
                    display: inline-block;
                    background-color: #9146ff;
                    color: white;
                    padding: 10px 20px;
                    text-decoration: none;
                    border-radius: 4px;
                    margin-top: 20px;
                }
                .back-button:hover {
                    background-color: #772ce8;
                }
                .keys-container {
                    margin-top: 20px;
                    padding: 15px;
                    background-color: #2a2a2a;
                    border-radius: 4px;
                    text-align: left;
                }
                .key-label {
                    color: #9146ff;
                    margin-bottom: 5px;
                }
                .key-value {
                    word-break: break-all;
                    font-family: monospace;
                    background-color: #1a1a1a;
                    padding: 10px;
                    border-radius: 4px;
                    margin-bottom: 15px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Bienvenue!</h1>
                <p class="welcome-message">Bienvenue ${displayName}!</p>
                
                <div class="keys-container">
                    <div class="key-label">Clé publique:</div>
                    <div id="publicKey" class="key-value">${publicKey || 'N/A'}</div>
                    <div class="key-label">Clé privée:</div>
                    <div id="privateKey" class="key-value">${privateKey || 'N/A'}</div>
                </div>

                <a href="/" class="back-button">Retour à l'accueil</a>
            </div>
        </body>
        </html>
    `;
}

// Middleware pour parser le JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connexion à MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connecté à MongoDB'))
    .catch(err => console.error('Erreur de connexion à MongoDB:', err));

// Middleware pour servir les fichiers statiques
app.use(express.static('public'));

// Route principale
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route pour démarrer l'authentification
app.get('/auth', (req, res) => {
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=${process.env.REDIRECT_URI}&response_type=code&scope=user:read:email`;
    res.redirect(authUrl);
});

// Route de callback après l'authentification
app.get('/callback', async (req, res) => {
    const { code } = req.query;
    
    let xrplClient; // Déclarer ici pour qu'il soit accessible dans le bloc finally
    try {
        // Échange du code contre un access token
        const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: process.env.TWITCH_CLIENT_ID,
                client_secret: process.env.TWITCH_CLIENT_SECRET,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: process.env.REDIRECT_URI
            }
        });

        const accessToken = tokenResponse.data.access_token;

        // Récupération des informations utilisateur Twitch
        const twitchUserResponse = await axios.get('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });

        const twitchUser = twitchUserResponse.data.data[0];

        // Vérifier si le streamer existe déjà
        const existingStreamer = await Streamer.findOne({ twitchId: twitchUser.id });
        console.log('Diagnostic: existingStreamer (initial) =', existingStreamer);
        console.log('Diagnostic: publicKey (initial) =', existingStreamer ? existingStreamer.publicKey : 'N/A');
        console.log('Diagnostic: seed (initial) =', existingStreamer ? existingStreamer.seed : 'N/A');

        if (existingStreamer && existingStreamer.publicKey && existingStreamer.seed) {
            // Cas 1: Streamer existant AVEC clés XRPL
            console.log('Cas 1: Streamer existant trouvé avec clés XRPL. Affichage direct.');
            res.send(generateWelcomePageHtml(
                twitchUser.display_name,
                existingStreamer.publicKey,
                existingStreamer.seed
            ));
        } else if (existingStreamer && (!existingStreamer.publicKey || !existingStreamer.seed)) {
            // Cas 2: Streamer existant SANS clés XRPL (génération et configuration)
            console.log('Cas 2: Streamer existant sans clés XRPL. Génération et configuration...');
            try {
                xrplClient = new xrpl.Client(process.env.XRPL_EXPLORER_URL);
                await xrplClient.connect();

                const userWallet = xrpl.Wallet.generate();
                console.log('Nouveau wallet utilisateur généré pour un streamer existant:', userWallet.seed, userWallet.address);

                const adminWallet = xrpl.Wallet.fromSeed(process.env.XRPL_HOT_WALLET_SEED);
                console.log(`Admin wallet: ${adminWallet.address}`);
                const adminBalanceResponse = await xrplClient.request({
                    command: "account_info",
                    account: adminWallet.address,
                    ledger_index: "validated"
                });
                const adminXrpBalance = xrpl.dropsToXrp(adminBalanceResponse.result.account_data.Balance);
                console.log(`Admin balance: ${adminXrpBalance} XRP`);

                if (parseFloat(adminXrpBalance) < INITIAL_FUNDING_XRP + 1.2) {
                    throw new Error("Solde du wallet admin insuffisant pour le financement initial.");
                }

                console.log(`Financement du wallet utilisateur existant avec ${INITIAL_FUNDING_XRP} XRP...`);
                const fundTx = await xrplClient.autofill({
                    TransactionType: "Payment",
                    Account: adminWallet.address,
                    Amount: xrpl.xrpToDrops(INITIAL_FUNDING_XRP.toString()),
                    Destination: userWallet.address
                });
                const fundTxSigned = adminWallet.sign(fundTx);
                const fundTxResult = await xrplClient.submitAndWait(fundTxSigned.tx_blob);
                console.log(`Financement transaction hash: ${fundTxResult.result.hash}`);
                await waitForValidation(xrplClient, fundTxResult.result.hash);

                console.log(`Activation de DEFAULT_RIPPLE sur le wallet utilisateur existant...`);
                const accountSetTx = await xrplClient.autofill({
                    TransactionType: "AccountSet",
                    Account: userWallet.address,
                    SetFlag: 8 // asfDefaultRipple
                });
                const accountSetTxSigned = userWallet.sign(accountSetTx);
                const accountSetTxResult = await xrplClient.submitAndWait(accountSetTxSigned.tx_blob);
                console.log(`AccountSet transaction hash: ${accountSetTxResult.result.hash}`);
                await waitForValidation(xrplClient, accountSetTxResult.result.hash);

                console.log(`Configuration de la trustline pour RLUSD pour l'utilisateur existant...`);
                const trustSetTx = await xrplClient.autofill({
                    TransactionType: "TrustSet",
                    Account: userWallet.address,
                    LimitAmount: {
                        currency: RLUSD_CURRENCY_HEX,
                        issuer: RLUSD_ISSUER,
                        value: "1000000" // Limite élevée pour ne pas restreindre les paiements
                    }
                });
                const trustSetTxSigned = userWallet.sign(trustSetTx);
                const trustSetTxResult = await xrplClient.submitAndWait(trustSetTxSigned.tx_blob);
                console.log(`TrustSet transaction hash: ${trustSetTxResult.result.hash}`);
                await waitForValidation(xrplClient, trustSetTxResult.result.hash);

                // Mettre à jour l'utilisateur existant avec les nouvelles clés XRPL
                const updatedStreamer = await Streamer.findOneAndUpdate(
                    { twitchId: twitchUser.id },
                    { publicKey: userWallet.address, seed: userWallet.seed },
                    { new: true } // Retourne le document mis à jour
                );
                console.log('Streamer existant mis à jour avec les nouvelles clés:', updatedStreamer);
                
                // Puis, afficher la page de bienvenue avec les nouvelles clés
                res.send(generateWelcomePageHtml(
                    twitchUser.display_name,
                    userWallet.address,
                    userWallet.seed
                ));

            } catch (error) {
                console.error('Erreur lors de la génération/configuration du wallet XRPL pour le streamer existant sans clés:', error.message);
                res.status(500).send(`
                    <!DOCTYPE html>
                    <html lang="fr">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>Erreur</title>
                        <style>
                            body {
                                font-family: Arial, sans-serif;
                                display: flex;
                                justify-content: center;
                                align-items: center;
                                height: 100vh;
                                margin: 0;
                                background-color: #18181b;
                                color: white;
                            }
                            .container {
                                text-align: center;
                                padding: 2rem;
                                background-color: #1f1f23;
                                border-radius: 8px;
                                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                            }
                            .error-message {
                                color: #ff0000;
                                margin: 20px 0;
                            }
                            .error-details {
                                color: #ff6666;
                                font-size: 0.9em;
                                margin-top: 20px;
                                text-align: left;
                                background: #2a2a2a;
                                padding: 10px;
                                border-radius: 4px;
                                overflow-x: auto;
                            }
                            .back-button {
                                display: inline-block;
                                background-color: #9146ff;
                                color: white;
                                padding: 10px 20px;
                                text-decoration: none;
                                border-radius: 4px;
                                margin-top: 20px;
                            }
                            .back-button:hover {
                                background-color: #772ce8;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <h1>Erreur</h1>
                            <p class="error-message">Une erreur est survenue lors de la configuration du wallet XRPL.</p>
                            <div class="error-details">
                                <pre>${JSON.stringify(error.message, null, 2)}</pre>
                            </div>
                            <a href="/" class="back-button">Retour à l'accueil</a>
                        </div>
                    </body>
                    </html>
                `);
            } finally {
                if (xrplClient && xrplClient.isConnected()) {
                    await xrplClient.disconnect();
                    console.log('Client XRPL déconnecté (après génération pour streamer existant sans clés).');
                }
            }
        } else {
            // Cas 3: Nouveau streamer (création et configuration)
            console.log('Nouveau streamer. Génération et configuration...');
            try {
                xrplClient = new xrpl.Client(process.env.XRPL_EXPLORER_URL);
                await xrplClient.connect();

                const userWallet = xrpl.Wallet.generate();
                console.log('Nouveau wallet utilisateur généré pour un nouveau streamer:', userWallet.seed, userWallet.address);

                const adminWallet = xrpl.Wallet.fromSeed(process.env.XRPL_HOT_WALLET_SEED);
                console.log(`Admin wallet: ${adminWallet.address}`);
                const adminBalanceResponse = await xrplClient.request({
                    command: "account_info",
                    account: adminWallet.address,
                    ledger_index: "validated"
                });
                const adminXrpBalance = xrpl.dropsToXrp(adminBalanceResponse.result.account_data.Balance);
                console.log(`Admin balance: ${adminXrpBalance} XRP`);

                if (parseFloat(adminXrpBalance) < INITIAL_FUNDING_XRP + 1.2) {
                    throw new Error("Solde du wallet admin insuffisant pour le financement initial.");
                }

                console.log(`Financement du wallet utilisateur avec ${INITIAL_FUNDING_XRP} XRP depuis le wallet admin...`);
                const fundTx = await xrplClient.autofill({
                    TransactionType: "Payment",
                    Account: adminWallet.address,
                    Amount: xrpl.xrpToDrops(INITIAL_FUNDING_XRP.toString()),
                    Destination: userWallet.address
                });
                const fundTxSigned = adminWallet.sign(fundTx);
                const fundTxResult = await xrplClient.submitAndWait(fundTxSigned.tx_blob);
                console.log(`Financement transaction hash: ${fundTxResult.result.hash}`);
                await waitForValidation(xrplClient, fundTxResult.result.hash);

                console.log(`Activation de DEFAULT_RIPPLE sur le wallet utilisateur...`);
                const accountSetTx = await xrplClient.autofill({
                    TransactionType: "AccountSet",
                    Account: userWallet.address,
                    SetFlag: 8 // asfDefaultRipple
                });
                const accountSetTxSigned = userWallet.sign(accountSetTx);
                const accountSetTxResult = await xrplClient.submitAndWait(accountSetTxSigned.tx_blob);
                console.log(`AccountSet transaction hash: ${accountSetTxResult.result.hash}`);
                await waitForValidation(xrplClient, accountSetTxResult.result.hash);

                console.log(`Configuration de la trustline pour RLUSD...`);
                const trustSetTx = await xrplClient.autofill({
                    TransactionType: "TrustSet",
                    Account: userWallet.address,
                    LimitAmount: {
                        currency: RLUSD_CURRENCY_HEX,
                        issuer: RLUSD_ISSUER,
                        value: "1000000" // Limite élevée pour ne pas restreindre les paiements
                    }
                });
                const trustSetTxSigned = userWallet.sign(trustSetTx);
                const trustSetTxResult = await xrplClient.submitAndWait(trustSetTxSigned.tx_blob);
                console.log(`TrustSet transaction hash: ${trustSetTxResult.result.hash}`);
                await waitForValidation(xrplClient, trustSetTxResult.result.hash);

                const streamerData = {
                    twitchId: twitchUser.id,
                    displayName: twitchUser.display_name,
                    login: twitchUser.login,
                    email: twitchUser.email,
                    publicKey: userWallet.address,
                    seed: userWallet.seed
                };

                const newStreamer = await Streamer.create(streamerData);
                console.log('Nouveau streamer créé avec clés:', newStreamer);

                // Afficher la page de bienvenue avec les clés pour le nouvel utilisateur
                res.send(generateWelcomePageHtml(
                    twitchUser.display_name,
                    userWallet.address,
                    userWallet.seed
                ));

            } catch (error) {
                console.error('Erreur lors de la génération/configuration du wallet XRPL pour le nouveau streamer:', error.message);
                res.status(500).send(`
                    <!DOCTYPE html>
                    <html lang="fr">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>Erreur</title>
                        <style>
                            body {
                                font-family: Arial, sans-serif;
                                display: flex;
                                justify-content: center;
                                align-items: center;
                                height: 100vh;
                                margin: 0;
                                background-color: #18181b;
                                color: white;
                            }
                            .container {
                                text-align: center;
                                padding: 2rem;
                                background-color: #1f1f23;
                                border-radius: 8px;
                                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                            }
                            .error-message {
                                color: #ff0000;
                                margin: 20px 0;
                            }
                            .error-details {
                                color: #ff6666;
                                font-size: 0.9em;
                                margin-top: 20px;
                                text-align: left;
                                background: #2a2a2a;
                                padding: 10px;
                                border-radius: 4px;
                                overflow-x: auto;
                            }
                            .back-button {
                                display: inline-block;
                                background-color: #9146ff;
                                color: white;
                                padding: 10px 20px;
                                text-decoration: none;
                                border-radius: 4px;
                                margin-top: 20px;
                            }
                            .back-button:hover {
                                background-color: #772ce8;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <h1>Erreur</h1>
                            <p class="error-message">Une erreur est survenue lors de la configuration du wallet XRPL.</p>
                            <div class="error-details">
                                <pre>${JSON.stringify(error.message, null, 2)}</pre>
                            </div>
                            <a href="/" class="back-button">Retour à l'accueil</a>
                        </div>
                    </body>
                    </html>
                `);
            } finally {
                if (xrplClient && xrplClient.isConnected()) {
                    await xrplClient.disconnect();
                    console.log('Client XRPL déconnecté (après génération pour nouveau streamer).');
                }
            }
        }
    } catch (error) {
        console.error('Erreur détaillée (callback route):', error.response ? error.response.data : error.message);
        res.status(500).send(`
            <!DOCTYPE html>
            <html lang="fr">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Erreur</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                        background-color: #18181b;
                        color: white;
                    }
                    .container {
                        text-align: center;
                        padding: 2rem;
                        background-color: #1f1f23;
                        border-radius: 8px;
                        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    }
                    .error-message {
                        color: #ff0000;
                        margin: 20px 0;
                    }
                    .error-details {
                        color: #ff6666;
                        font-size: 0.9em;
                        margin-top: 20px;
                        text-align: left;
                        background: #2a2a2a;
                        padding: 10px;
                        border-radius: 4px;
                        overflow-x: auto;
                    }
                    .back-button {
                        display: inline-block;
                        background-color: #9146ff;
                        color: white;
                        padding: 10px 20px;
                        text-decoration: none;
                        border-radius: 4px;
                        margin-top: 20px;
                    }
                    .back-button:hover {
                        background-color: #772ce8;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Erreur</h1>
                    <p class="error-message">Une erreur est survenue lors de l'authentification.</p>
                    <div class="error-details">
                        <pre>${JSON.stringify(error.response ? error.response.data : error.message, null, 2)}</pre>
                    </div>
                    <a href="/" class="back-button">Retour à l'accueil</a>
                </div>
            </body>
            </html>
        `);
    } finally {
        if (xrplClient && xrplClient.isConnected()) {
            await xrplClient.disconnect();
            console.log('Client XRPL déconnecté (dans le finally de callback).');
        }
    }
});

app.listen(port, () => {
    console.log(`Serveur démarré sur http://localhost:${port}`);
}); 