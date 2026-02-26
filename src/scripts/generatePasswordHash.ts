import crypto from "node:crypto";

const password = process.argv[2];
if (!password) {
  // eslint-disable-next-line no-console
  console.error("Usage: npm run security:hash-password -- <password>");
  process.exit(1);
}

const iterations = 210_000;
const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");

// eslint-disable-next-line no-console
console.log(`pbkdf2_sha256$${iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}`);
