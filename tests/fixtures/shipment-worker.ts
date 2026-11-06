import { Store } from '../../src/storage/store.js';
import { shipmentCommandSchema } from '../../src/domain/shipping.js';
const store = new Store(process.argv[2]!),
  command = shipmentCommandSchema.parse(JSON.parse(process.argv[3]!));
process.send?.('ready');
process.once('message', () => {
  try {
    store.commerce.shipment(
      'sample-seller-01',
      'O-0002',
      command,
      new Date('2026-11-06T10:00:00+09:00'),
    );
    process.send?.('saved');
  } catch (e) {
    process.send?.(e instanceof Error ? e.message : 'failed');
  } finally {
    store.close();
    process.disconnect?.();
  }
});
