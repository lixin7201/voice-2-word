const { loadEnvFile } = require('./lib/env');
const { createVoiceServer } = require('./app');

loadEnvFile();

const server = createVoiceServer();
const port = Number(process.env.PORT || 8127);
const host = process.env.HOST || '0.0.0.0';

server.listen(port, host, () => {
  console.log(`大宜宾录音助手后端已启动：http://localhost:${port}`);
});
