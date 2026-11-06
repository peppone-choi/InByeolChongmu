import { Store } from '../../src/storage/store.js';
import { confirmOrderSchema } from '../../src/domain/commerce.js';
const store = new Store(process.argv[2]!);
const input = confirmOrderSchema.parse(JSON.parse(process.argv[4]!));
process.send?.('ready');
process.once('message', () => {
  try {
    store.commerce.confirm(
      'sample-seller-01',
      process.argv[3]!,
      input,
      new Date('2026-11-05T10:00:00+09:00'),
    );
    process.send?.('confirmed');
  } catch (e) {
    process.send?.(e instanceof Error ? e.message : 'failed');
  } finally {
    store.close();
    process.disconnect?.();
  }
});
