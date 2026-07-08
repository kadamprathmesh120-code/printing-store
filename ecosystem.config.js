module.exports = {
  apps: [
    {
      name: 'printing-store-server',
      script: 'server.js',
      cwd: __dirname,
      env: { PORT: 3000 }
    },
    {
      name: 'printing-store-printer',
      script: 'local-printer.js',
      cwd: __dirname
    }
  ]
};
