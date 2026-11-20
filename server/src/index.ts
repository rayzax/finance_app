import { createApp } from './app';
import { assertStartupConfig, getConfig } from './lib/config';

const cfg = getConfig();
assertStartupConfig(cfg);
if (!cfg.isProduction && !cfg.appPasswordHash) console.warn('[warn] APP_PASSWORD_HASH is not set; login will always fail');

createApp().listen(cfg.port, () => {
  console.log(`Reserve server listening on :${cfg.port} (${cfg.nodeEnv}, plaid=${cfg.plaidEnv})`);
});
