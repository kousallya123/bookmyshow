import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();

console.log('Add these to Render Environment:');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('VAPID_SUBJECT=mailto:you@example.com');
