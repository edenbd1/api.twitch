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

// XRPL Constants
const RLUSD_CURRENCY_HEX = process.env.XRPL_RLUSD_CURRENCY_HEX;
const RLUSD_ISSUER = process.env.XRPL_RLUSD_ISSUER;
const INITIAL_FUNDING_XRP = 1.2; // Initial amount in XRP for new wallets

// Utility function to wait for XRPL transaction validation
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

// Function to generate welcome page with keys
function generateWelcomePageHtml(displayName, publicKey, privateKey) {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Welcome</title>
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
                <h1>Welcome!</h1>
                <p class="welcome-message">Welcome ${displayName}!</p>
                
                <div class="keys-container">
                    <div class="key-label">Public Key:</div>
                    <div id="publicKey" class="key-value">${publicKey || 'N/A'}</div>
                    <div class="key-label">Private Key:</div>
                    <div id="privateKey" class="key-value">${privateKey || 'N/A'}</div>
                </div>

                <a href="/" class="back-button">Back to Home</a>
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
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// Middleware pour servir les fichiers statiques
app.use(express.static('public'));

// Route principale
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route for starting authentication
app.get('/auth', (req, res) => {
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=${process.env.REDIRECT_URI}&response_type=code&scope=user:read:email`;
    res.redirect(authUrl);
});

// Callback route after authentication
app.get('/callback', async (req, res) => {
    const { code } = req.query;
    
    let xrplClient;
    try {
        // Exchange code for access token
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

        // Get Twitch user information
        const twitchUserResponse = await axios.get('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });

        const twitchUser = twitchUserResponse.data.data[0];

        // Check if streamer already exists
        let streamer = await Streamer.findOne({ twitchId: twitchUser.id });

        if (streamer && streamer.publicKey && streamer.seed) {
            // Case 1: Existing streamer WITH XRPL keys
            console.log('Case 1: Existing streamer found with XRPL keys. Direct display.');
            res.send(generateWelcomePageHtml(
                twitchUser.display_name,
                streamer.publicKey,
                streamer.seed
            ));
        } else {
            // Case 2: New streamer OR existing streamer WITHOUT XRPL keys (generation and configuration)
            console.log('Case 2: New streamer or existing streamer without XRPL keys. Generation and configuration...');
            try {
                xrplClient = new xrpl.Client(process.env.XRPL_EXPLORER_URL);
                await xrplClient.connect();

                const userWallet = xrpl.Wallet.generate();
                console.log('User wallet generated:', userWallet.seed, userWallet.address);

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
                    throw new Error("Insufficient admin wallet balance for initial funding.");
                }

                console.log(`Funding user wallet with ${INITIAL_FUNDING_XRP} XRP from admin wallet...`);
                const fundTx = await xrplClient.autofill({
                    TransactionType: "Payment",
                    Account: adminWallet.address,
                    Amount: xrpl.xrpToDrops(INITIAL_FUNDING_XRP.toString()),
                    Destination: userWallet.address
                });
                const fundTxSigned = adminWallet.sign(fundTx);
                const fundTxResult = await xrplClient.submitAndWait(fundTxSigned.tx_blob);
                console.log(`Funding transaction hash: ${fundTxResult.result.hash}`);
                await waitForValidation(xrplClient, fundTxResult.result.hash);

                console.log(`Enabling DEFAULT_RIPPLE on user wallet...`);
                const accountSetTx = await xrplClient.autofill({
                    TransactionType: "AccountSet",
                    Account: userWallet.address,
                    SetFlag: 8 // asfDefaultRipple
                });
                const accountSetTxSigned = userWallet.sign(accountSetTx);
                const accountSetTxResult = await xrplClient.submitAndWait(accountSetTxSigned.tx_blob);
                console.log(`AccountSet transaction hash: ${accountSetTxResult.result.hash}`);
                await waitForValidation(xrplClient, accountSetTxResult.result.hash);

                console.log(`Setting up RLUSD trustline...`);
                const trustSetTx = await xrplClient.autofill({
                    TransactionType: "TrustSet",
                    Account: userWallet.address,
                    LimitAmount: {
                        currency: RLUSD_CURRENCY_HEX,
                        issuer: RLUSD_ISSUER,
                        value: "1000000" // High limit to not restrict payments
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

                if (streamer) {
                    // Update existing user
                    streamer = await Streamer.findOneAndUpdate(
                        { twitchId: twitchUser.id },
                        { $set: streamerData },
                        { new: true }
                    );
                    console.log('Existing streamer updated with XRPL keys:', streamer);
                } else {
                    // Create new user
                    streamer = await Streamer.create(streamerData);
                    console.log('New streamer created with XRPL keys:', streamer);
                }

                res.send(generateWelcomePageHtml(
                    twitchUser.display_name,
                    streamer.publicKey,
                    streamer.seed
                ));

            } catch (error) {
                console.error('Error during XRPL wallet generation/configuration:', error.message);
                res.status(500).send(`
                    <!DOCTYPE html>
                    <html lang="en">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>Error</title>
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
                            <h1>Error</h1>
                            <p class="error-message">An error occurred during XRPL wallet configuration.</p>
                            <div class="error-details">
                                <pre>${JSON.stringify(error.message, null, 2)}</pre>
                            </div>
                            <a href="/" class="back-button">Back to Home</a>
                        </div>
                    </body>
                    </html>
                `);
            } finally {
                if (xrplClient && xrplClient.isConnected()) {
                    await xrplClient.disconnect();
                    console.log('XRPL client disconnected.');
                }
            }
        }
    } catch (error) {
        console.error('Detailed error (callback route):', error.response ? error.response.data : error.message);
        res.status(500).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Error</title>
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
                    <h1>Error</h1>
                    <p class="error-message">An error occurred during authentication.</p>
                    <div class="error-details">
                        <pre>${JSON.stringify(error.response ? error.response.data : error.message, null, 2)}</pre>
                    </div>
                    <a href="/" class="back-button">Back to Home</a>
                </div>
            </body>
            </html>
        `);
    } finally {
        if (xrplClient && xrplClient.isConnected()) {
            await xrplClient.disconnect();
            console.log('XRPL client disconnected (in callback finally).');
        }
    }
});

app.listen(port, () => {
    console.log(`Server started on http://localhost:${port}`);
}); 