import ExcelJS from 'exceljs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { productSchema, type Product } from '../domain/schema.js';
import type { Store } from './store.js';
const columns = [
  'product_id',
  'name',
  'aliases',
  'material',
  'closes_at',
  'measurements_cm',
  'sku',
  'color',
  'size',
  'unit_price_krw',
  'stock_available',
] as const;
function cell(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  throw new AppError(
    'UNSUPPORTED_CELL',
    '수식·링크·서식 객체 대신 텍스트·숫자 셀을 사용하세요.',
  );
}
export async function exportProducts(
  store: Store,
  sellerId: string,
  file: string,
) {
  const workbook = new ExcelJS.Workbook(),
    sheet = workbook.addWorksheet('products');
  sheet.addRow([...columns]);
  sheet.getRow(1).font = { bold: true };
  for (const product of store.products(sellerId))
    for (const variant of product.variants)
      sheet.addRow([
        product.product_id,
        product.name,
        product.aliases.join('|'),
        product.material ?? '',
        product.closes_at,
        product.measurements_cm === null
          ? ''
          : JSON.stringify(product.measurements_cm),
        variant.sku,
        variant.color,
        variant.size,
        variant.unit_price_krw,
        variant.stock_available,
      ]);
  sheet.columns.forEach((column) => {
    column.width = 24;
  });
  await workbook.xlsx.writeFile(file);
}
export async function importProducts(
  store: Store,
  sellerId: string,
  file: string,
) {
  if ((await stat(file)).size > 2 * 1024 * 1024)
    throw new AppError(
      'WORKBOOK_TOO_LARGE',
      '상품 파일은 최대 2 MiB입니다.',
      413,
    );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet('products');
  if (
    !sheet ||
    sheet.rowCount < 2 ||
    sheet.rowCount > 10001 ||
    sheet.columnCount !== columns.length
  )
    throw new AppError(
      'INVALID_WORKBOOK',
      'products 시트와 1~10,000개 상품 행이 필요합니다.',
    );
  if (
    columns.some(
      (column, index) =>
        cell(sheet.getRow(1).getCell(index + 1).value) !== column,
    )
  )
    throw new AppError(
      'INVALID_HEADERS',
      '내보낸 상품 양식의 열 이름·순서를 유지하세요.',
    );
  const grouped = new Map<string, Product>();
  for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex++) {
    const row = sheet.getRow(rowIndex);
    if (!row.hasValues) continue;
    const cells = columns.map((_, i) => cell(row.getCell(i + 1).value));
    const [
      id,
      name,
      aliases,
      material,
      closesAt,
      measurements,
      sku,
      color,
      size,
      price,
      stock,
    ] = cells;
    const aliasText = z.string().parse(aliases ?? ''),
      measurementText = z.string().parse(measurements ?? '');
    const product = productSchema.parse({
      product_id: id,
      name,
      aliases: aliasText ? aliasText.split('|') : [],
      material: material === '' ? null : material,
      closes_at: closesAt,
      measurements_cm: measurementText ? JSON.parse(measurementText) : null,
      variants: [
        { sku, color, size, unit_price_krw: price, stock_available: stock },
      ],
    });
    const previous = grouped.get(product.product_id);
    if (previous) {
      if (
        JSON.stringify({ ...previous, variants: [] }) !==
        JSON.stringify({ ...product, variants: [] })
      )
        throw new AppError(
          'CONFLICTING_PRODUCT',
          '같은 상품의 공통 정보가 행마다 다릅니다.',
        );
      previous.variants.push(...product.variants);
    } else grouped.set(product.product_id, product);
  }
  return store.replaceProducts(sellerId, [...grouped.values()]);
}
