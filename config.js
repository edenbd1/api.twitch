module.exports = {
    // Remplacez ces valeurs par celles obtenues sur https://dev.twitch.tv/console
    TWITCH_CLIENT_ID: process.env.TWITCH_CLIENT_ID,
    TWITCH_CLIENT_SECRET: process.env.TWITCH_CLIENT_SECRET,
    REDIRECT_URI: process.env.REDIRECT_URI || 'https://votre-site.vercel.app/callback',
    WAVETIP_API_URL: 'https://api.wavetip.io'
}; 