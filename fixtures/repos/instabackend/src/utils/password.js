// bcrypt hashing/verification, isolated so the rest of the app never touches bcrypt directly
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 12;

const hashPassword = (plain) => bcrypt.hash(plain, SALT_ROUNDS);

const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

module.exports = { hashPassword, verifyPassword };
