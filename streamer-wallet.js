const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Streamer = require('./models/Streamer');
const xrplUtils = require('./xrpl-utils');

// Route pour vérifier l'existence d'un streamer et créer un wallet si nécessaire
router.post('/verify-streamer', async (req, res) => {
    const { name, password } = req.body;
    
    if (!name || !password) {
        return res.status(400).json({ error: "Le nom du streamer et le mot de passe sont requis" });
    }

    try {
        // Vérifier si le streamer existe
        const streamer = await Streamer.findOne({
            $or: [
                { login: { $regex: new RegExp(name, 'i') } },
                { displayName: { $regex: new RegExp(name, 'i') } }
            ]
        });

        if (streamer) {
            // Si le streamer existe déjà, retourner son adresse wallet
            return res.json({
                exists: true,
                walletAddress: streamer.walletAddress
            });
        }

        // Si le streamer n'existe pas, créer un nouveau wallet
        const wallet = await xrplUtils.createWallet();
        
        // Chiffrer la clé privée avec le mot de passe
        const encryptedPrivateKey = xrplUtils.encryptPrivateKey(wallet.privateKey, password);
        
        // Créer un nouveau streamer avec le wallet
        const newStreamer = new Streamer({
            twitchId: null, // Sera mis à jour lors de l'authentification Twitch
            displayName: name,
            login: name.toLowerCase(),
            email: null, // Sera mis à jour lors de l'authentification Twitch
            walletAddress: wallet.address,
            encryptedPrivateKey: encryptedPrivateKey
        });

        await newStreamer.save();

        // Configurer le wallet en arrière-plan
        try {
            // Financer le wallet avec 1.21 XRP
            await xrplUtils.fundWallet(wallet.address);
            
            // Activer DEFAULT_RIPPLE
            await xrplUtils.enableDefaultRipple(wallet.seed);
            
            // Configurer la trustline RLUSD
            await xrplUtils.setupRLUSDTrustline(wallet.seed);
            
            console.log(`Wallet configuré avec succès pour ${name}`);
        } catch (configError) {
            console.error(`Erreur lors de la configuration du wallet pour ${name}:`, configError);
            // Ne pas renvoyer l'erreur à l'utilisateur pour ne pas perturber son expérience
        }

        res.json({
            exists: false,
            walletAddress: wallet.address
        });

    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ error: "Une erreur est survenue" });
    }
});

module.exports = router; 