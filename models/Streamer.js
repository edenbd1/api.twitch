const mongoose = require('mongoose');

const streamerSchema = new mongoose.Schema({
    twitchId: { type: String, required: true, unique: true },
    login: { type: String, required: true },
    displayName: { type: String, required: true },
    type: String,
    broadcasterType: String,
    description: String,
    profileImageUrl: String,
    offlineImageUrl: String,
    viewCount: Number,
    email: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Streamer', streamerSchema); 