const express = require('express');
const axios = require('axios');
const path = require('path');
const config = require('./config');

const app = express();
const port = 3000;

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

        // Affichage des données sur la page
        res.send(`
            <!DOCTYPE html>
            <html lang="fr">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Connexion réussie</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        margin: 0;
                        padding: 20px;
                        background-color: #18181b;
                        color: white;
                    }
                    .container {
                        max-width: 800px;
                        margin: 0 auto;
                        padding: 2rem;
                        background-color: #1f1f23;
                        border-radius: 8px;
                        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    }
                    .success-message {
                        color: #00ff00;
                        margin: 20px 0;
                    }
                    .data-section {
                        margin: 20px 0;
                        padding: 15px;
                        background-color: #2a2a2a;
                        border-radius: 4px;
                    }
                    .data-section h2 {
                        color: #9146ff;
                        margin-top: 0;
                    }
                    pre {
                        background-color: #1a1a1a;
                        padding: 15px;
                        border-radius: 4px;
                        overflow-x: auto;
                        white-space: pre-wrap;
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
                    <h1>Connexion réussie!</h1>
                    <p class="success-message">Bienvenue ${twitchUser.display_name}!</p>
                    
                    <div class="data-section">
                        <h2>Données Twitch</h2>
                        <pre>${JSON.stringify(twitchUser, null, 2)}</pre>
                    </div>

                    <a href="/" class="back-button">Retour à l'accueil</a>
                </div>
            </body>
            </html>
        `);
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