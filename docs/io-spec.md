# 입력·출력 명세

상태: 계약 `0.1` · 채팅/대화방/자료 API·Flue 분석·웹 검토, 주문 저장/판매자 확정·재고, 발송/정정·이력과 공통 택배 명단/열 설정을 구현했습니다. 실제 HTTP 요청·응답은 [백엔드 사용법](backend.md)을 기준으로 합니다. JSON 키는 코드용, 설명과 화면 문구는 한글입니다.

## 1. 분석 입력

정확한 예시는 [DM 사례](samples/dm-cases.json)의 `cases[].input`을 사용합니다.

- `schema_version`: 문자열 `0.1`.
- `request_id`: 판매자 범위의 요청 식별자. 분석 재시도 식별에 사용하며 주문 확정 키와 다릅니다.
- `seller_id`: 단일 판매자 식별자. 운영에서는 클라이언트 값을 신뢰하지 않고 인증 문맥과 대조합니다.
- `reference_time`: 시간대가 있는 기준 시각. 샘플은 `2026-11-05T10:00:00+09:00`로 고정합니다. 운영의 마감 판정 시각은 서버가 제공합니다.
- `customer_handle`: 비어 있지 않은 고객 아이디, 샘플에서는 `@sample.` 접두사를 사용합니다.
- `text`: DM 원문. 공백만 있는 본문은 빈 본문입니다.
- `attachments`: 배열, 없으면 `[]`. 사진만 있으면 지원 불가이며 이미지 내용을 분석하지 않습니다.
- `snapshots`: `products`·`policies`·`orders` 자료 버전. 샘플 로더는 fixture를 읽고, 운영에서는 허용된 자료만 조회합니다.

가상 샘플은 작성용 `conversation` 배열의 발화를 `[고객]`·`[판매자]`로 구분해 `text`에 이어 씁니다. 이 배열과 `scenario`·`tags`는 평가 자료의 메타데이터이며 분석 입력의 추가 필드는 아닙니다. 표기는 붙여넣은 비신뢰 텍스트일 뿐 실제 발신자·권한을 증명하지 않습니다. 앞 대화는 맥락으로 사용하되 미해결 요청과 최신 정정을 구분합니다. 기존 기록의 주소 변경·취소나 정책에 없는 할인은 판매자 확인으로 넘깁니다.

일괄 입력은 `{schema_version, batch_id, entries: [분석 입력, ...]}` 형식 제안입니다. 요청·고객별 결과와 실패를 개별 반환하며 대화를 임의로 이어 붙이지 않습니다. 건수·본문 길이 제한은 비용·지연 측정 후 정합니다.

## 1.1. 채팅 수신 HTTP API (로컬 구현)

`POST /api/chat`은 고객 DM을 받아 대화방에 저장합니다. `AGENT_BACKEND=flue`와 OpenAI 모델·키를 설정하면 방 맥락을 읽고 도구를 호출한 뒤 검증된 분석을 `200`으로 반환합니다. 미설정은 `503`, 모델/검증 실패는 `503`, 실행 제한 시간 초과는 `504`입니다. 종료된 요청 ID의 성공·실패는 저장된 결과를 재사용합니다. 자세한 경로·HTTP 오류·입력 제한은 [백엔드 사용법](backend.md)을 따릅니다.

- 요청: `schema_version`, `customer_handle`, `text` 필수. `attachments`는 `{type}` 배열로 생략 시 `[]`, `request_id`·`conversation_id`는 선택입니다. 추가 필드와 빈 텍스트/첨부는 거절합니다.
- 서버 문맥: `seller_id`·자료 버전·처리 시각을 외부 본문에서 받지 않습니다. 현재는 로컬 가상 판매자만 지원하고 실제 운영 인증은 없습니다.
- 대화방: `conversation_id`를 보내면 판매자·고객을 검사한 뒤 이어 저장합니다. 생략하면 새 방을 만들고 응답에 ID를 반환합니다. 같은 고객도 맥락별로 여러 방을 만들 수 있습니다. 서버가 같은 방의 최근 이력을 모델 맥락으로 구성하며 다른 방의 대화를 합치지 않습니다.
- 응답: `{conversation_id, replayed, analysis, execution?}`. 실행 기록은 안전한 도구 상태만 포함합니다. `analysis`는 아래 출력 계약을 사용합니다. 모델이 없으면 정상 초안을 만들지 않습니다. 사진 전용 입력은 `200`이지만 상태는 `unsupported`입니다.
- 재전송: 같은 판매자의 같은 `request_id`·본문·고객·방은 한 번만 저장합니다. 다른 내용이나 방으로 바꾸면 `409`입니다. 메시지 저장 성공과 모델 분석 성공을 구분합니다.
- 분석 API는 주문·재고 쓰기 권한을 갖지 않습니다. 인스타그램 직접 연결·고객 자동 응답·주문 확정 기능은 포함하지 않습니다.

## 2. 분석 출력

전체 예시: [DM-002 기대 출력](samples/analysis-example.json). 아래 키를 항상 제공하고 값이 없으면 `null` 또는 빈 배열을 사용합니다.

- `schema_version`, `request_id`: 계약 버전과 입력 요청 식별자.
- `classification`: `product_inquiry | order_request | payment_claim | order_lookup | claim | unrelated`. 입력 오류·지원 불가 때만 `invalid_input | unsupported`를 사용합니다. 분류 전 실행 실패는 `null`입니다.
- `status`: `invalid_input | unsupported | human_review | needs_info | awaiting_payment | ready_for_review | ignored | failed`. 영속 주문 상태와 별개입니다.
- `priority`: `normal | high`. 클레임은 `high`.
- `reply_draft`: 문자열 또는 `null`. 전송됐다는 의미가 아닙니다.
- `order_candidates`, `product_candidates`: ID 배열. 판매자 전용 조회 정보입니다.
- `matched_skus`: 특정된 SKU 배열. 주문 후보가 없는 상품 문의에서도 조회된 옵션을 나타냅니다. 상품이 모호하면 빈 배열입니다.
- `order_draft`: 아래 주문 후보 객체 또는 `null`. 분석만으로 저장·확정하지 않습니다.
- `missing_fields`, `invalid_fields`: 필드 경로 문자열 배열.
- `review_items`: `{code, message}` 배열. 미확인·차단 사유를 명시하고 실행 실패에는 `retryable`도 제공합니다.
- `evidence`: `{source_type, source_id, snapshot_id, field_paths}` 배열. 유형은 `product | policy | order`, 필드 경로는 source ID 내부의 사람이 읽는 위치 표기입니다. 실행 가능한 JSONPath로 취급하지 않습니다.
- `state_mutation_allowed`: 분석에서는 항상 `false`.

모델이 반환한 허용 플래그로 쓰기 권한을 결정하지 않습니다. 분석 경로 자체에 주문·재고 변경 기능을 연결하지 않습니다.

상태 우선순위: 입력 오류 → 지원 불가 → 처리 실패 → 판매자 판단 필요 → 정보 보완 → 입금 확인 대기 → 초안 검토 가능. 판매 무관은 `ignored`입니다. 수동 입금·주소 확인 안내만 있는 완전한 주문은 `awaiting_payment`이며 다른 차단 사유를 숨기지 않습니다.

## 3. 주문 후보와 값 규칙

`order_draft`는 `customer_handle`, `recipient{name, phone_raw, address_raw, postal_code}`, `depositor_name`, `customer_claimed_paid`, `items[]`, `amounts`, `address_verification`으로 구성합니다.

- `items[]`: `{product_id, sku, quantity, unit_price_krw}`. 수량은 양의 정수, 가격은 상품표에서 읽은 정수입니다. 미특정 상품·수량은 `null`로 보존하며 추측하지 않습니다.
- 필수값: 상품·옵션·수량·이름·연락처·주소·입금자명. 후보 단계에서는 누락값을 `null`로 두고 `missing_fields`에 표시합니다. 우편번호 필수 여부는 택배 양식으로 정합니다.
- `amounts`: `{subtotal_krw, discount_krw, shipping_fee_krw, total_krw}`. 금액은 음수가 아닌 원 단위 정수. 상품·수량·가격·정책 중 계산 근거가 부족하거나 잘못되면 객체 전체를 `null`로 둡니다.
- 연락처는 원문을 보존하고 숫자 정규화 후 국내 휴대폰 형식 등 허용 규칙을 검사합니다. 샘플 정상 번호는 `010` 뒤 8자리이며 번호 존재·소유자 확인을 뜻하지 않습니다.
- `address_verification`: `not_checked | matched | no_match | ambiguous | failed | manually_confirmed`. API 조회 결과는 상세 동·호수·실제 수령지를 보장하지 않습니다.
- “입금했어요”는 `customer_claimed_paid=true`일 뿐입니다. 입금 완료 상태를 생성하지 않습니다.

현재 분석 예시는 품목별 SKU·상품 ID·수량·단가를 상품 스냅샷 및 DM 기대값과 대조한 뒤 금액을 검사합니다. 이미 저장된 과거 주문은 저장 당시 단가·할인·배송비로 산술만 검증하며 현재 정책을 다시 적용하지 않습니다. 과거 정책의 적합성까지 검증한 것은 아닙니다.

주문 생성·수정은 분석과 별도인 주문 후보 저장 명령입니다. 실제 경로는 `POST /api/orders/from-analysis`와 `PUT /api/orders/:id`입니다. 서버가 ID를 부여해 불완전한 후보는 `draft`, 필수값·정책 검증을 통과한 후보는 `pending_payment`로 저장합니다. 저장만으로 재고를 예약·차감하지 않습니다. 중복 고객·유사 주문을 표시하되 본문이 같다는 이유만으로 다른 실제 주문을 삭제하지 않습니다.

## 4. 주문 확정 명령과 응답

명령 필수값: `command_id`(멱등 키), `order_id`, `expected_version`, `reviewed_snapshots`, `payment_checked=true`, `checked_amount_krw`, `checked_depositor_name`, `address_acknowledged=true`. 승인자·확인 시각은 신뢰 가능한 서버 문맥에서 기록합니다. 주소 검색 API 성공을 필수 조건으로 강제하지 않지만 미검사 상태와 판매자 수령지 확인은 기록합니다.

성공 응답: `{command_id, order_id, status:"confirmed", version, replayed:false}`. 현재 확정 API는 `{order}`를 반환하며 동일 명령 재호출도 저장된 주문을 반환합니다. 발송 명령은 아래처럼 `replayed`를 따로 제공합니다. 별도 키로 이미 확정한 주문을 요청하면 기존 상태를 반환하고 다시 차감하지 않습니다.

실패 응답: `{command_id, status:"rejected", code, message, retryable}`. 금액·입금자명·확인 플래그·최신 버전·정책·재고를 재검사하고, 실패 시 일부 품목만 차감하지 않습니다. 저장소 트랜잭션 또는 동등한 원자적 보장이 필요합니다.

## 5. 오류·확인 코드

- 입력·추출: `HANDLE_REQUIRED`, `TEXT_REQUIRED`, `INVALID_PHONE`, `INVALID_QUANTITY`, `INVALID_JSON`.
- 근거·조회: `PRODUCT_UNRESOLVED`, `PRODUCT_AMBIGUOUS`, `SOURCE_MISSING`, `ORDER_NOT_FOUND`, `ORDER_AMBIGUOUS`.
- 판단·가용성: `OUT_OF_STOCK`, `INSUFFICIENT_STOCK`, `SALE_CLOSED`, `SELLER_DECISION_REQUIRED`, `MANUAL_PAYMENT_CHECK`, `ADDRESS_UNVERIFIED`.
- 실행 실패: `DEPENDENCY_UNAVAILABLE`, `OUTPUT_MISMATCH`, `STALE_VERSION`, `IDEMPOTENCY_CONFLICT`, `PAYMENT_MISMATCH`, `APPROVAL_REQUIRED`.
- 발송 등록: `FORBIDDEN`, `SHIPMENT_FIELDS_REQUIRED`, `INVALID_SHIPMENT_TIME`, `INVALID_ORDER_STATE`, `SHIPMENT_ALREADY_RECORDED`. 주문 없음은 `ORDER_NOT_FOUND`, 버전·키 충돌은 위 공통 코드를 사용합니다.

확인 코드는 사용자 보완/판단이 필요하고 자동 반복하지 않습니다. 장애 코드는 `retryable`을 구분하며 구체적 재시도 횟수·대기값은 구현 시 정합니다. JSON 실패·초안 검증 실패 때 검증되지 않은 초안을 정상 결과로 노출하지 않습니다.

## 6. 내보내기 계약

내부 공통 행은 `order_id, recipient_name, phone, postal_code, address, item_summary, total_krw, shipping_memo`입니다. 한 주문당 한 행에 상품을 합치며, 실제 택배사 어댑터가 대상 열·자료형으로 변환합니다. 이 목록을 실제 택배 업로드 양식이라고 주장하지 않습니다.

결과는 `export_id`, `template_version`, `included_order_ids`, `excluded[{order_id, reason}]`, 파일 정보입니다. 전화·우편번호는 문자열로 유지하고 고객 입력의 수식 실행을 막습니다. 파일 생성은 주문 발송이나 송장 발급을 뜻하지 않습니다. 현재는 택배사 미정에 따라 공통 명단과 열 설정을 구현·검증했습니다. 실제 택배사 업로드 호환성은 미검증입니다. 파일은 확정·미발송 주문만 포함하고 미확정/취소/기발송/필수값 누락은 사유와 함께 제외합니다. 재내보내기는 이전 횟수·시각을 보여주고 중복 접수 위험을 확인합니다. 파일 생성과 발송 기록은 서로 다른 명령입니다.

## 7. 수동 발송·송장 등록 및 정정 계약

주문·발송 서비스를 구현했습니다. 판매자가 기존 택배 프로그램에서 실제 발송을 확인한 뒤 직접 기록합니다. 택배사 API 발급·자동 동기화는 추가하지 않습니다. [SHIP-001 가상 명령과 기대 응답](samples/shipment-example.json)은 문서 계약 예시이며 주문 파일을 변경하지 않습니다.

### 최초 등록: `register_shipment`

입력은 `schema_version`, `operation`, `command_id`, `order_id`, `expected_version`, `carrier`, `tracking_number`, `shipped_at`입니다. 택배사·송장번호는 공백 제거 후 비어 있지 않은 문자열로 받고 송장 앞자리 0을 보존합니다. 발송 시각은 시간대 포함 시각이며 `confirmed_at ≤ shipped_at ≤ 서버 현재 시각`이어야 합니다. 현재는 비어 있지 않은 최대 100자 문자열만 확인하며 택배사별 번호 규칙은 미검증입니다. 번호의 실제 존재나 배송 상태를 확인했다고 표시하지 않습니다.

서버는 인증한 판매자의 주문인지 확인합니다. 최초 등록의 허용 상태는 `confirmed`이며 성공하면 송장 정보·발송일·감사 기록과 버전 증가를 원자적으로 저장해 `shipped`로 바꿉니다. `draft/pending_payment/cancelled`는 `INVALID_ORDER_STATE`, 이미 `shipped`인 주문의 새 등록 명령은 `SHIPMENT_ALREADY_RECORDED`로 거절합니다.

성공 응답은 `{command_id, order_id, status:"shipped", version, replayed:false, order, event}`이며 버전은 기존 값 + 1입니다. 거절 응답은 `{command_id, status:"rejected", code, message, retryable}`입니다. 검증 실패·버전 충돌·저장 실패 시 일부 필드나 감사 기록만 반영하지 않습니다. 등록은 재고·금액·수령인·입금 상태를 변경하지 않습니다.

### 재시도·정정

승인·등록·정정 명령의 키는 판매자 범위에서 공유합니다. 권한 확인 후 동일 키의 저장 결과를 먼저 확인합니다. 동일한 정규화 요청은 저장된 응답에 `replayed:true`만 바꿔 반환하고, 현재 버전이 달라도 다시 저장하지 않습니다. 같은 키의 다른 operation·주문·필드·버전은 `IDEMPOTENCY_CONFLICT`로 거절합니다. 저장 결과가 없는 새 명령만 버전·상태를 검사합니다. 문자열 공백과 시각 표현은 정규화한 뒤 요청 지문에 포함합니다.

오입력은 별도 `update_shipment` 명령으로 정정합니다. 최초 등록과 같은 필드에 비어 있지 않은 `correction_reason`을 추가하고, `shipped` 상태·최신 버전만 허용합니다. 시각·필수값 검증과 응답 형식은 최초 등록과 같습니다. 성공 시 `shipped`를 유지하고 버전만 1 증가시키며 변경 전후 값·사유·서버 승인자·수정 시각을 제한된 감사 기록에 남깁니다. 재시도 규칙도 동일하고 재고는 다시 차감하지 않습니다. 취소·환불·발송 취소 명령으로 사용하지 않습니다.
