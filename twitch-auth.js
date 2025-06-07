const express = require('express');
const axios = require('axios');
const path = require('path');
const mongoose = require('mongoose');
const config = require('./config');
const Streamer = require('./models/Streamer');
const xrplUtils = require('./xrpl-utils');

const app = express();
const port = 3000;

// Middleware pour parser le JSON
app.use(express.json());

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
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${config.TWITCH_CLIENT_ID}&redirect_uri=${config.REDIRECT_URI}&response_type=code&scope=user:read:email`;
    res.redirect(authUrl);
});

// Route pour créer le wallet
app.post('/create-wallet', async (req, res) => {
    const { twitchId, password } = req.body;
    
    if (!twitchId || !password) {
        return res.status(400).json({ error: "Twitch ID et mot de passe requis" });
    }

    try {
        const streamer = await Streamer.findOne({ twitchId });
        
        if (!streamer) {
            return res.status(404).json({ error: "Streamer non trouvé" });
        }

        if (streamer.walletAddress) {
            return res.status(400).json({ error: "Wallet déjà créé" });
        }

        // Créer le wallet
        const wallet = await xrplUtils.createWallet();
        
        // Chiffrer la clé privée
        const encryptedPrivateKey = xrplUtils.encryptPrivateKey(wallet.privateKey, password);
        
        // Mettre à jour le streamer
        streamer.walletAddress = wallet.address;
        streamer.encryptedPrivateKey = encryptedPrivateKey;
        await streamer.save();

        // Configurer le wallet en arrière-plan
        try {
            await xrplUtils.fundWallet(wallet.address);
            await xrplUtils.enableDefaultRipple(wallet.seed);
            await xrplUtils.setupRLUSDTrustline(wallet.seed);
            console.log(`Wallet configuré avec succès pour ${streamer.displayName}`);
        } catch (configError) {
            console.error(`Erreur lors de la configuration du wallet:`, configError);
        }

        res.json({ 
            success: true, 
            walletAddress: wallet.address,
            explorerUrl: `${process.env.XRPL_EXPLORER_URL}/accounts/${wallet.address}`
        });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ error: "Une erreur est survenue" });
    }
});

// Route de callback après l'authentification
app.get('/callback', async (req, res) => {
    const { code } = req.query;
    
    try {
        // Échange du code contre un access token
        const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: config.TWITCH_CLIENT_ID,
                client_secret: config.TWITCH_CLIENT_SECRET,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: config.REDIRECT_URI
            }
        });

        const accessToken = tokenResponse.data.access_token;

        // Récupération des informations utilisateur Twitch
        const twitchUserResponse = await axios.get('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Client-Id': config.TWITCH_CLIENT_ID
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
                        }
                        .welcome-message {
                            color: #00ff00;
                            margin: 20px 0;
                        }
                        .wallet-info {
                            background-color: #2a2a2a;
                            padding: 15px;
                            border-radius: 4px;
                            margin: 20px 0;
                            word-break: break-all;
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
                        <h1>Hello again!</h1>
                        <p class="welcome-message">Bienvenue ${twitchUser.display_name}!</p>
                        <div class="wallet-info">
                            <p>Votre wallet XRPL :</p>
                            <p>${existingStreamer.walletAddress}</p>
                            <a href="${process.env.XRPL_EXPLORER_URL}/accounts/${existingStreamer.walletAddress}" target="_blank">Voir sur l'explorateur</a>
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

            const newStreamer = new Streamer(streamerData);
            await newStreamer.save();

            res.send(`
                <!DOCTYPE html>
                <html lang="fr">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Créer votre wallet</title>
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
                            max-width: 400px;
                        }
                        .welcome-message {
                            color: #00ff00;
                            margin: 20px 0;
                        }
                        .password-form {
                            margin: 20px 0;
                        }
                        .password-input {
                            width: 100%;
                            padding: 10px;
                            margin: 10px 0;
                            border: 1px solid #3a3a3a;
                            border-radius: 4px;
                            background-color: #1a1a1a;
                            color: white;
                            font-size: 16px;
                        }
                        .submit-button {
                            background-color: #9146ff;
                            color: white;
                            border: none;
                            padding: 10px 20px;
                            border-radius: 4px;
                            cursor: pointer;
                            font-size: 16px;
                            margin-top: 10px;
                        }
                        .submit-button:hover {
                            background-color: #772ce8;
                        }
                        .error-message {
                            color: #ff0000;
                            margin-top: 10px;
                            display: none;
                        }
                        .wallet-info {
                            background-color: #2a2a2a;
                            padding: 15px;
                            border-radius: 4px;
                            margin: 20px 0;
                            word-break: break-all;
                            display: none;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>Bienvenue ${twitchUser.display_name}!</h1>
                        <p class="welcome-message">Créez votre wallet XRPL</p>
                        <div class="password-form">
                            <input type="password" id="password" class="password-input" placeholder="Choisissez un mot de passe">
                            <button onclick="createWallet()" class="submit-button">Créer mon wallet</button>
                            <p id="error" class="error-message"></p>
                        </div>
                        <div id="walletInfo" class="wallet-info">
                            <p>Votre wallet XRPL a été créé :</p>
                            <p id="walletAddress"></p>
                            <a id="explorerLink" href="#" target="_blank">Voir sur l'explorateur</a>
                        </div>
                    </div>

                    <script>
                        async function createWallet() {
                            const password = document.getElementById('password').value;
                            const errorElement = document.getElementById('error');
                            const walletInfo = document.getElementById('walletInfo');
                            const walletAddress = document.getElementById('walletAddress');
                            const explorerLink = document.getElementById('explorerLink');
                            
                            if (!password) {
                                errorElement.textContent = "Veuillez entrer un mot de passe";
                                errorElement.style.display = "block";
                                return;
                            }

                            try {
                                const response = await fetch('/create-wallet', {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify({
                                        twitchId: '${twitchUser.id}',
                                        password: password
                                    })
                                });

                                const data = await response.json();

                                if (data.error) {
                                    errorElement.textContent = data.error;
                                    errorElement.style.display = "block";
                                } else {
                                    errorElement.style.display = "none";
                                    walletInfo.style.display = "block";
                                    walletAddress.textContent = data.walletAddress;
                                    explorerLink.href = data.explorerUrl;
                                }
                            } catch (error) {
                                errorElement.textContent = "Une erreur est survenue";
                                errorElement.style.display = "block";
                            }
                        }
                    </script>
                </body>
                </html>
            `);
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