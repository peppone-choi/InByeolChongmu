import { Store } from './storage/store.js';
import { readConfig, type Config } from './config.js';
export function bootstrap(config: Config = readConfig()) {
  const store = new Store(config.databasePath);
  try {
    store.seedSamples(config.root, config.sellerId);
    return { store, config };
  } catch (error) {
    store.close();
    throw error;
  }
}
