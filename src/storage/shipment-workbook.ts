import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import {
  shipmentImportRequestSchema,
  type ShipmentImportEntry,
} from '../domain/shipping.js';
import { AppError } from '../domain/errors.js';
import type { Commerce } from './commerce.js';
import { checkWorkbookZip } from './data-workbook.js';

const columns = ['주문 ID', '택배사', '송장번호', '발송 시각'];
const aliases = ['order_id', 'carrier', 'tracking_number', 'shipped_at'];

export async function shipmentWorkbookTemplate() {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('송장 등록');
  sheet.columns = columns.map((header) => ({
    header,
    width: 34,
    style: { numFmt: '@' },
  }));
  sheet.getRow(1).font = { bold: true };
  return book.xlsx.writeBuffer();
}

export async function previewShipments(
  commerce: Commerce,
  seller: string,
  file: Buffer,
  now = new Date(),
) {
  checkWorkbookZip(file);
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(file as never);
  } catch {
    throw new AppError('INVALID_WORKBOOK', '엑셀 파일을 읽을 수 없습니다.');
  }
  const sheet = book.worksheets[0];
  if (!sheet || sheet.rowCount > 201 || sheet.columnCount > 50)
    throw new AppError(
      'INVALID_WORKBOOK',
      '첫 시트에 최대 200건·50열을 넣어 주세요.',
    );
  const headers = Array.from({ length: sheet.columnCount }, (_, i) =>
    String(sheet.getRow(1).getCell(i + 1).value ?? '')
      .trim()
      .replace(/\s+/g, ''),
  );
  const positions = columns.map((name, i) =>
    headers.flatMap((header, index) =>
      header === name.replace(/\s+/g, '') || header === aliases[i]
        ? [index + 1]
        : [],
    ),
  );
  if (positions.some((matches) => matches.length !== 1))
    throw new AppError(
      'INVALID_HEADERS',
      '주문 ID·택배사·송장번호·발송 시각 열을 하나씩 넣어 주세요.',
    );
  const entries: ShipmentImportEntry[] = [];
  const errors: { row: number; message: string }[] = [];
  const seen = new Set<string>();
  for (let row = 2; row <= sheet.rowCount; row++) {
    const line = sheet.getRow(row);
    if (!line.hasValues) continue;
    try {
      const [orderId, carrier, tracking, time] = positions.map(([index]) => {
        const value = line.getCell(index!).value;
        if (typeof value !== 'string' || !value.trim())
          throw new AppError(
            'INVALID_CELL',
            '필수 네 열을 텍스트로 입력하세요. 송장번호는 앞자리 0을 포함해 보존됩니다.',
          );
        return value.trim();
      }) as [string, string, string, string];
      if (seen.has(orderId))
        throw new AppError(
          'DUPLICATE_ORDER',
          '이 파일에 주문 ID가 중복됐습니다.',
        );
      seen.add(orderId);
      const order = commerce.get(seller, orderId);
      if (order.status !== 'confirmed')
        throw new AppError(
          'INVALID_ORDER_STATE',
          '확정·미발송 주문만 일괄 등록할 수 있습니다.',
        );
      const parsed = shipmentImportRequestSchema.safeParse({
        entries: [
          {
            row,
            order_id: orderId,
            command: {
              operation: 'register_shipment',
              command_id: randomUUID(),
              expected_version: order.version,
              carrier,
              tracking_number: tracking,
              shipped_at: time,
            },
          },
        ],
      });
      if (!parsed.success)
        throw new AppError(
          'INVALID_CELL',
          '입력 길이와 발송 시각 형식(예: 2026-11-13T14:30:00+09:00)을 확인하세요.',
        );
      const entry = parsed.data.entries[0]!;
      if (
        !order.confirmed_at ||
        Date.parse(entry.command.shipped_at) < Date.parse(order.confirmed_at) ||
        Date.parse(entry.command.shipped_at) > now.getTime()
      )
        throw new AppError(
          'INVALID_SHIPMENT_TIME',
          '발송 시각은 주문 확정 이후이며 현재 시각을 넘을 수 없습니다.',
        );
      entries.push(entry);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      errors.push({ row, message: error.message });
    }
  }
  if (!entries.length && !errors.length)
    throw new AppError('INVALID_WORKBOOK', '등록할 송장 행을 입력하세요.');
  return { entries, errors };
}
