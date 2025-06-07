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
            <title>Définir le mot de passe</title>
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
                .form-group {
                    margin: 15px 0;
                }
                input {
                    width: 100%;
                    padding: 10px;
                    margin: 5px 0;
                    border: 1px solid #3a3a3a;
                    border-radius: 4px;
                    background-color: #1a1a1a;
                    color: white;
                    font-size: 16px;
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
                <h1>Définir votre mot de passe</h1>
                <form id="passwordForm" onsubmit="return validateForm(event)">
                    <div class="form-group">
                        <input type="password" id="password" placeholder="Mot de passe" required>
                    </div>
                    <div class="form-group">
                        <input type="password" id="confirmPassword" placeholder="Confirmer le mot de passe" required>
                    </div>
                    <div id="error" class="error"></div>
                    <button type="submit">Valider</button>
                </form>
            </div>
            <script>
                function validateForm(event) {
                    event.preventDefault();
                    const password = document.getElementById('password').value;
                    const confirmPassword = document.getElementById('confirmPassword').value;
                    const errorDiv = document.getElementById('error');

                    if (password !== confirmPassword) {
                        errorDiv.textContent = 'Les mots de passe ne correspondent pas';
                        return false;
                    }

                    fetch('/save-password', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ 
                            password,
                            twitchId: '${twitchId}'
                        })
                    })
                    .then(response => response.json())
                    .then(data => {
                        if (data.success) {
                            window.location.href = '/';
                        } else {
                            errorDiv.textContent = data.error;
                        }
                    })
                    .catch(error => {
                        errorDiv.textContent = 'Une erreur est survenue';
                    });

                    return false;
                }
            </script>
        </body>
        </html>
    `);
});

// Route pour sauvegarder le mot de passe et générer la clé XRPL
app.post('/save-password', async (req, res) => {
    const { password, twitchId } = req.body;

    if (!twitchId) {
        return res.json({ success: false, error: 'ID Twitch manquant' });
    }

    try {
        // Générer une nouvelle clé XRPL
        const wallet = xrpl.Wallet.generate();
        const privateKey = wallet.privateKey;
        const publicKey = wallet.publicKey;

        // Chiffrer la clé privée avec le mot de passe
        const encryptedKey = CryptoJS.AES.encrypt(privateKey, password).toString();

        // Mettre à jour le streamer dans la base de données avec les deux clés
        await Streamer.findOneAndUpdate(
            { twitchId },
            { 
                publicKey,
                encryptedKey
            }
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Erreur lors de la sauvegarde:', error);
        res.json({ success: false, error: 'Erreur lors de la sauvegarde' });
    }
});

// Route pour vérifier le mot de passe et afficher la clé privée
app.post('/check-password', async (req, res) => {
    const { password, twitchId } = req.body;

    try {
        const streamer = await Streamer.findOne({ twitchId });
        if (!streamer || !streamer.encryptedKey) {
            return res.json({ success: false, error: 'Aucune clé trouvée' });
        }

        // Tenter de déchiffrer la clé privée
        try {
            const decryptedKey = CryptoJS.AES.decrypt(streamer.encryptedKey, password).toString(CryptoJS.enc.Utf8);
            if (!decryptedKey) {
                return res.json({ success: false, error: 'Mot de passe incorrect' });
            }
            res.json({ 
                success: true, 
                privateKey: decryptedKey,
                publicKey: streamer.publicKey
            });
        } catch (error) {
            res.json({ success: false, error: 'Mot de passe incorrect' });
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
                        .form-group {
                            margin: 15px 0;
                        }
                        input {
                            width: 100%;
                            padding: 10px;
                            margin: 5px 0;
                            border: 1px solid #3a3a3a;
                            border-radius: 4px;
                            background-color: #1a1a1a;
                            color: white;
                            font-size: 16px;
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
                        
                        <div class="form-group">
                            <input type="password" id="password" placeholder="Entrez votre mot de passe pour voir vos clés">
                            <div id="error" class="error"></div>
                            <button onclick="checkPassword()">Voir mes clés</button>
                        </div>

                        <div id="keysContainer" class="keys-container" style="display: none;">
                            <div class="key-label">Clé publique:</div>
                            <div id="publicKey" class="key-value"></div>
                            <div class="key-label">Clé privée:</div>
                            <div id="privateKey" class="key-value"></div>
                        </div>

                        <a href="/" class="back-button">Retour à l'accueil</a>
                    </div>

                    <script>
                        function checkPassword() {
                            const password = document.getElementById('password').value;
                            const errorDiv = document.getElementById('error');
                            const keysContainer = document.getElementById('keysContainer');

                            fetch('/check-password', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({ 
                                    password,
                                    twitchId: '${twitchUser.id}'
                                })
                            })
                            .then(response => response.json())
                            .then(data => {
                                if (data.success) {
                                    errorDiv.textContent = '';
                                    document.getElementById('publicKey').textContent = data.publicKey;
                                    document.getElementById('privateKey').textContent = data.privateKey;
                                    keysContainer.style.display = 'block';
                                } else {
                                    errorDiv.textContent = data.error;
                                    keysContainer.style.display = 'none';
                                }
                            })
                            .catch(error => {
                                errorDiv.textContent = 'Une erreur est survenue';
                                keysContainer.style.display = 'none';
                            });
                        }
                    </script>
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