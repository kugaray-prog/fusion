// PM2 process definition for the VPS deploy path (DEPLOYMENT.md Part 4).
// Not needed if you're deploying to a PaaS like Railway (Part 3) -- Railway
// runs `npm start` itself and doesn't use PM2.
//
// First-time start on the server:
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup        # prints a command to run once, so PM2 (and this
//                       # app) comes back up automatically after a reboot
//
// After that, .github/workflows/deploy-vps.yml keeps it updated with:
//   pm2 reload geoattend-pro
module.exports = {
  apps: [
    {
      name: 'geoattend-pro',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      },
      max_memory_restart: '500M',
      // onnxruntime-node loads a native addon; a clean restart handles
      // that far more reliably than PM2's default file-watch/reload path.
      watch: false
    }
  ]
};
