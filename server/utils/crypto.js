const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_FILE = path.join(__dirname, '.secret.key');
const ALGORITHM = 'aes-256-cbc';

// Ensure we have a persistent secret key
let SECRET_KEY;
if (fs.existsSync(SECRET_FILE)) {
    SECRET_KEY = Buffer.from(fs.readFileSync(SECRET_FILE, 'utf8'), 'hex');
} else {
    SECRET_KEY = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_FILE, SECRET_KEY.toString('hex'));
}

const IV_LENGTH = 16;

function encrypt(text) {
    if (!text) return text;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    if (!text) return text;
    try {
        const textParts = text.split(':');
        if (textParts.length !== 2) return text; // Return original if not formatted
        const iv = Buffer.from(textParts[0], 'hex');
        const encryptedText = Buffer.from(textParts[1], 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (e) {
        console.error('Decryption failed:', e.message);
        return text; // Fallback to original (in case of legacy plain text)
    }
}

module.exports = { encrypt, decrypt };
