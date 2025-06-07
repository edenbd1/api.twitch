const express = require('express');
const axios = require('axios');
const path = require('path');
const mongoose = require('mongoose');
const config = require('./config');
const Streamer = require('./models/Streamer');
const CryptoJS = require('crypto-js');
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

// Route pour afficher le formulaire de mot de passe
app.get('/set-password', (req, res) => {
    const { twitchId } = req.query;
    
    if (!twitchId) {
        return res.redirect('/');
    }

    res.send(`
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Génération du wallet</title>
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
                    max-width: 400px;
                }
                button {
                    background-color: #9146ff;
                    color: white;
                    border: none;
                    padding: 12px 24px;
                    border-radius: 4px;
                    font-size: 16px;
                    cursor: pointer;
                    width: 100%;
                    margin-top: 20px;
                }
                button:hover {
                    background-color: #772ce8;
                }
                .error {
                    color: #ff0000;
                    margin-top: 10px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Génération du wallet</h1>
                <div id="error" class="error"></div>
                <button onclick="generateWallet()">Générer mon wallet</button>
            </div>
            <script>
                function generateWallet() {
                    fetch('/save-password', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ 
                            twitchId: '${twitchId}'
                        })
                    })
                    .then(response => response.json())
                    .then(data => {
                        if (data.success) {
                            window.location.href = '/';
                        } else {
                            document.getElementById('error').textContent = data.error;
                        }
                    })
                    .catch(error => {
                        document.getElementById('error').textContent = 'Une erreur est survenue';
                    });
                }
            </script>
        </body>
        </html>
    `);
});

// Route pour générer la clé XRPL
app.post('/save-password', async (req, res) => {
    const { twitchId } = req.body;

    if (!twitchId) {
        return res.json({ success: false, error: 'ID Twitch manquant' });
    }

    let xrplClient; // Déclarer xrplClient en dehors du try pour qu'il soit accessible dans finally
    try {
        xrplClient = new xrpl.Client(process.env.XRPL_EXPLORER_URL);
        await xrplClient.connect();

        // 1. Générer une nouvelle clé XRPL pour l'utilisateur
        const userWallet = xrpl.Wallet.generate();
        console.log('Nouveau wallet utilisateur généré:');
        console.log('Seed:', userWallet.seed);
        console.log('Address:', userWallet.address);

        // 2. Charger le wallet admin (Hot Wallet)
        const adminWallet = xrpl.Wallet.fromSeed(process.env.XRPL_HOT_WALLET_SEED);
        console.log(`Admin wallet: ${adminWallet.address}`);

        // 3. Vérifier le solde de l'admin
        const adminBalanceResponse = await xrplClient.request({
            command: "account_info",
            account: adminWallet.address,
            ledger_index: "validated"
        });
        const adminXrpBalance = xrpl.dropsToXrp(adminBalanceResponse.result.account_data.Balance);
        console.log(`Admin balance: ${adminXrpBalance} XRP`);

        if (parseFloat(adminXrpBalance) < INITIAL_FUNDING_XRP + 1.2) { // +1.2 XRP pour la réserve et les frais de transaction
            throw new Error("Solde du wallet admin insuffisant pour le financement initial.");
        }

        // 4. Financer le wallet utilisateur avec XRP depuis le wallet admin
        console.log(`Financement du wallet utilisateur avec ${INITIAL_FUNDING_XRP} XRP depuis le wallet admin...`);
        const fundTx = await xrplClient.autofill({
            TransactionType: "Payment",
            Account: adminWallet.address,
            Amount: xrpl.xrpToDrops(INITIAL_FUNDING_XRP.toString()),
            Destination: userWallet.address
        });
        const fundTxSigned = adminWallet.sign(fundTx);
        const fundTxResult = await xrplClient.submitAndWait(fundTxSigned.tx_blob);
        console.log(`Financement réussi! Transaction hash: ${fundTxResult.result.hash}`);
        await waitForValidation(xrplClient, fundTxResult.result.hash);

        // 5. Activer DEFAULT_RIPPLE sur le wallet utilisateur
        console.log(`Activation de DEFAULT_RIPPLE sur le wallet utilisateur...`);
        const accountSetTx = await xrplClient.autofill({
            TransactionType: "AccountSet",
            Account: userWallet.address,
            SetFlag: 8 // asfDefaultRipple
        });
        const accountSetTxSigned = userWallet.sign(accountSetTx);
        const accountSetTxResult = await xrplClient.submitAndWait(accountSetTxSigned.tx_blob);
        console.log(`DEFAULT_RIPPLE activé avec succès! Transaction hash: ${accountSetTxResult.result.hash}`);
        await waitForValidation(xrplClient, accountSetTxResult.result.hash);

        // 6. Configurer la trustline pour RLUSD
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
        console.log(`Trustline configurée avec succès! Transaction hash: ${trustSetTxResult.result.hash}`);
        await waitForValidation(xrplClient, trustSetTxResult.result.hash);

        // 7. Mettre à jour le streamer dans la base de données avec les clés générées
        await Streamer.findOneAndUpdate(
            { twitchId },
            { 
                publicKey: userWallet.address,
                seed: userWallet.seed
            }
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Erreur lors de la génération/configuration du wallet XRPL:', error.message);
        res.json({ success: false, error: `Erreur lors de la configuration du wallet XRPL: ${error.message}` });
    } finally {
        if (xrplClient && xrplClient.isConnected()) {
            await xrplClient.disconnect();
            console.log('Client XRPL déconnecté.');
        }
    }
});

// Route pour vérifier le mot de passe et afficher la clé privée
app.post('/check-password', async (req, res) => {
    const { twitchId } = req.body;

    try {
        const streamer = await Streamer.findOne({ twitchId });
        if (!streamer || !streamer.seed) {
            console.log('Aucune clé trouvée pour twitchId:', twitchId);
            return res.json({ success: false, error: 'Aucune clé trouvée' });
        }

        console.log('Données trouvées:');
        console.log('Clé publique stockée:', streamer.publicKey);
        console.log('Seed stockée:', streamer.seed);

        // Vérifier si le seed est valide
        try {
            console.log('Tentative de création du wallet avec le seed');
            const wallet = xrpl.Wallet.fromSeed(streamer.seed);
            console.log('Wallet créé avec succès');
            console.log('Adresse du wallet:', wallet.address);
            console.log('Adresse stockée:', streamer.publicKey);

            // Vérification plus détaillée
            if (wallet.address !== streamer.publicKey) {
                console.log('Les adresses ne correspondent pas:');
                console.log('Wallet généré:', wallet.address);
                console.log('Stockée:', streamer.publicKey);
                return res.json({ success: false, error: 'Clé privée invalide' });
            }

            console.log('Validation réussie, envoi des clés');
            res.json({ 
                success: true, 
                privateKey: streamer.seed,
                publicKey: streamer.publicKey
            });
        } catch (error) {
            console.error('Erreur lors de la création du wallet:', error);
            return res.json({ success: false, error: 'Clé privée invalide' });
        }
    } catch (error) {
        console.error('Erreur lors de la vérification:', error);
        res.json({ success: false, error: 'Erreur lors de la vérification' });
    }
});

// Route de callback après l'authentification
app.get('/callback', async (req, res) => {
    const { code } = req.query;
    
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

        if (existingStreamer) {
            // Streamer existant
            res.send(`
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
                        <h1>Hello again!</h1>
                        <p class="welcome-message">Bienvenue ${twitchUser.display_name}!</p>
                        
                        <div class="keys-container">
                            <div class="key-label">Clé publique:</div>
                            <div id="publicKey" class="key-value">${existingStreamer.publicKey}</div>
                            <div class="key-label">Clé privée:</div>
                            <div id="privateKey" class="key-value">${existingStreamer.seed}</div>
                        </div>

                        <a href="/" class="back-button">Retour à l'accueil</a>
                    </div>
                </body>
                </html>
            `);
        } else {
            // Nouveau streamer
            const streamerData = {
                twitchId: twitchUser.id,
                displayName: twitchUser.display_name,
                login: twitchUser.login,
                email: twitchUser.email
            };

            // Sauvegarder les données de base
            await Streamer.create(streamerData);

            // Rediriger vers le formulaire de mot de passe avec l'ID Twitch
            res.redirect(`/set-password?twitchId=${twitchUser.id}`);
        }
    } catch (error) {
        console.error('Erreur détaillée:', error.response ? error.response.data : error.message);
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
    }
});

app.listen(port, () => {
    console.log(`Serveur démarré sur http://localhost:${port}`);
}); 