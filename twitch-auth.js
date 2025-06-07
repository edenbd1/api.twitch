const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
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
        console.log('Code reçu:', code);
        console.log('Client ID:', config.TWITCH_CLIENT_ID);
        console.log('Redirect URI:', config.REDIRECT_URI);

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

        console.log('Token response:', tokenResponse.data);

        const accessToken = tokenResponse.data.access_token;

        // Récupération des informations utilisateur Twitch
        const twitchUserResponse = await axios.get('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Client-Id': config.TWITCH_CLIENT_ID
            }
        });

        console.log('User response:', twitchUserResponse.data);

        const twitchUser = twitchUserResponse.data.data[0];
        
        // Sauvegarde des données Twitch
        await fs.writeFile('twitch_user.json', JSON.stringify(twitchUser, null, 2));

        // Appel à l'API Wavetip
        const wavetipResponse = await axios.get(`${config.WAVETIP_API_URL}/streamer/${twitchUser.login}`);
        
        // Sauvegarde des données Wavetip
        await fs.writeFile('wavetip_user.json', JSON.stringify(wavetipResponse.data, null, 2));

        // Redirection vers une page de succès
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
                    .success-message {
                        color: #00ff00;
                        margin: 20px 0;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Connexion réussie!</h1>
                    <p class="success-message">Bienvenue ${twitchUser.display_name}!</p>
                    <p>Vos informations ont été sauvegardées avec succès.</p>
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
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Erreur</h1>
                    <p class="error-message">Une erreur est survenue lors de l'authentification.</p>
                    <div class="error-details">
                        <pre>${JSON.stringify(error.response ? error.response.data : error.message, null, 2)}</pre>
                    </div>
                    <p>Veuillez réessayer plus tard.</p>
                </div>
            </body>
            </html>
        `);
    }
});

app.listen(port, () => {
    console.log(`Serveur démarré sur http://localhost:${port}`);
}); 