import {
  initTLS,
  destroyTLS,
  Session,
  ClientIdentifier,
} from 'node-tls-client';

await initTLS();

const session = new Session({
  clientIdentifier: ClientIdentifier.safari_ios_18_0,
  timeout: 20_000,
});

const urls = [
  'https://in.bookmyshow.com/movies/coimbatore/ramayana/buytickets/ET00523959/20261119?etCodes=ET00523959&language=tamil&refEventCode=ET00523959',
  'https://in.bookmyshow.com/movies/coimbatore/ramayana/buytickets/ET00523959/20261120?etCodes=ET00523959&language=tamil&refEventCode=ET00523959',
];

for (const url of urls) {
  const res = await session.get(url, { followRedirects: true });
  const text = await res.text();
  const finalUrl = res.url || url;
  const compact = (String(finalUrl).match(/\/(\d{8})/) || [])[1];
  const blocked = /you have been blocked/i.test(text);
  const broadway = /Broadway/i.test(text);
  const showTimes = [...text.matchAll(/"showTime"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  console.log({
    req: (url.match(/\/(\d{8})/) || [])[1],
    status: res.status,
    finalCompact: compact,
    len: text.length,
    blocked,
    broadway,
    shows: [...new Set(showTimes)].slice(0, 8),
  });
}

await session.close();
await destroyTLS();
