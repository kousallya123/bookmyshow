process.env.ROLE = 'worker';
if (!process.env.CHECK_MODE) process.env.CHECK_MODE = 'playwright';
await import('../src/index.js');
