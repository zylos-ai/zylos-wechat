module.exports = {
  apps: [
    {
      name: 'zylos-wechat',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 1000,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
