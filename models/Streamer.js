const mongoose = require('mongoose');

const streamerSchema = new mongoose.Schema({
    twitchId: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    login: { type: String, required: true },
    email: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Streamer', streamerSchema); 