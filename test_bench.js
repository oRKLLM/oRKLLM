const http = require('http');

const req = http.request({
  hostname: 'localhost',
  port: 8080,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
}, (res) => {
  res.on('data', (chunk) => {
    console.log('CHUNK:', chunk.toString());
  });
});

req.write(JSON.stringify({
  model: 'foo',
  messages: [{ role: 'user', content: 'Explain the theory of relativity' }],
  stream: true,
  max_tokens: 10
}));

req.end();
