import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { bootstrap } from '../bootstrap.js';
import { Tools, toolCatalog } from '../tools/registry.js';
import { FlueRunner } from '../agent/flue-runner.js';
import { ChatService } from '../agent/service.js';
import { importProducts, exportProducts } from '../storage/workbook.js';
import { serveMcp } from '../tools/mcp.js';
import { AppError } from '../domain/errors.js';
const { store, config } = bootstrap();
const [command, name, ...rest] = process.argv.slice(2);
let keepOpen = false;
const runner = new FlueRunner(store, config);
try {
  if (command === 'mcp') {
    keepOpen = true;
    const server = await serveMcp(store, config);
    const close = async () => {
      await server.close();
      store.close();
      process.exit(0);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    process.stdin.once('end', close);
  } else if (command === 'seed')
    console.log(
      JSON.stringify({
        status: 'ready',
        products: store.products(config.sellerId).length,
        orders: store.orders(config.sellerId).length,
      }),
    );
  else if (command === 'tools')
    console.log(
      JSON.stringify(
        name
          ? new Tools(store, config.sellerId, config.root).call(
              name,
              JSON.parse(rest.join(' ') || '{}'),
            )
          : toolCatalog(),
        null,
        2,
      ),
    );
  else if (command === 'chat') {
    if (!name)
      throw new AppError(
        'INPUT_REQUIRED',
        '채팅 요청 JSON 파일 경로가 필요합니다.',
      );
    const result = await new ChatService(store, config, runner).receive(
      JSON.parse(await readFile(resolve(name), 'utf8')),
    );
    console.log(JSON.stringify(result.body, null, 2));
    if (result.httpStatus !== 200) process.exitCode = 2;
  } else if (command === 'export' && name) {
    await exportProducts(store, config.sellerId, resolve(name));
    console.log('상품 엑셀 내보내기 완료');
  } else if (command === 'import' && name)
    console.log(
      JSON.stringify(
        await importProducts(store, config.sellerId, resolve(name)),
      ),
    );
  else if (command === 'backup' && name) {
    await store.backupTo(resolve(name));
    console.log('SQLite 백업 완료');
  } else
    throw new AppError(
      'USAGE',
      'seed | tools [name JSON] | chat <JSON 파일> | export <xlsx> | import <xlsx> | backup <파일> | mcp',
    );
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        code: error instanceof AppError ? error.code : 'COMMAND_FAILED',
        message:
          error instanceof AppError
            ? error.message
            : '자료 형식과 파일 경로를 확인하세요.',
      },
    }),
  );
  process.exitCode = 1;
} finally {
  if (!keepOpen) {
    await runner.stop();
    store.close();
  }
}
