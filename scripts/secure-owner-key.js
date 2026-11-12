// Run locally. Never prints the generated credential.
import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
const file = '.env';
let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
if ((dotenv.parse(content).OWNER_KEY || '').length < 32) {
  const line = `OWNER_KEY=${crypto.randomBytes(32).toString('base64url')}`;
  content = /^OWNER_KEY=.*$/m.test(content) ? content.replace(/^OWNER_KEY=.*$/m, line) : `${content}\n${line}\n`;
  fs.writeFileSync(file, content, { mode: 0o600 });
}
console.log('Strong owner credential configured locally. Credential value was not printed.');
if (fs.existsSync('.env.example')) {
  const example = fs.readFileSync('.env.example', 'utf8').replace(/^OWNER_KEY=.*$/m, 'OWNER_KEY=');
  fs.writeFileSync('.env.example', example);
}
