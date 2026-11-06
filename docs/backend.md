# 백엔드와 자료 도구

현재 구현은 가상 자료용 백엔드와 실제 모델 실행 경로입니다. Hono → ChatService → Flue → OpenAI → 자료 도구 → 검증된 분석 JSON 순서로 동작합니다. TypeSafe 키가 있으면 Jev 분류를 에이전트 도구로 연결합니다. Docker 단일 서버 실행을 지원합니다.

## 실행 환경과 명령

Node.js `26.5.1` 이상 `27` 미만, npm을 사용합니다. `.node-version`의 검증 버전은 `26.5.1`입니다. `node:sqlite`의 `DatabaseSync`를 사용하며 해당 모듈은 아직 안정화 완료 API가 아니므로 Node 업데이트 시 재검증합니다. 로컬 실행에는 별도 DB 서버·Docker가 필요 없으며 컨테이너 실행 시 Docker Compose가 필요합니다.

```sh
npm ci
cp .env.example .env.local
npm run db:seed
npm run dev
```

이미 `.env.local`이 있으면 복사로 덮어쓰지 마세요. `.env.local` → `.env` 순서로 읽고, 셸 환경 변수가 최종 우선입니다. 필요한 키 이름은 `.env.example`에만 빈 값으로 제공합니다. 실제 환경 파일은 Git에서 제외합니다. `AGENT_BACKEND=flue`, `AGENT_MODEL=openai/gpt-5.5`, `OPENAI_API_KEY`를 설정하면 실제 모델을 호출합니다. 기본 `disabled`는 모델을 호출하지 않습니다. `TYPESAFE_API_KEY`를 넣으면 `TYPESAFE_MODEL=jev-latest` 분류 도구를 추가합니다. 키 변경 후 프로세스를 재시작하세요. Provider 키는 앱 설정 JSON·에이전트 입력·Flue env에 전달하지 않고 메모리의 인증 함수에서만 읽습니다.

- `npm run build` / `npm start`: 컴파일 / 컴파일된 HTTP 서버 실행.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`: 타입·린트·포맷·동작 검사.
- `npm run db:seed`: 자료가 없는 판매자 영역에만 가상 자료를 적재합니다. 재시작이나 재실행으로 수정 자료를 덮어쓰지 않습니다.
- `npm run tools`: 도구 목록과 입력 스키마.
- `npm run tools -- search_products '{"query":"가디건"}'`: 실제 SQLite 상품 검색.
- `npm run tools -- quote_order '{"items":[{"sku":"K-BE","quantity":1},{"sku":"K-CR","quantity":1}]}'`: 코드 금액 계산.
- `npm run chat -- /절대/경로/request.json`: HTTP와 동일한 실행기로 채팅 JSON을 분석합니다. 모델 미연결·실패 시 메시지를 저장하고 오류 JSON 및 종료 코드 `2`를 반환합니다.
- `npm run data:export -- /절대/경로/products.xlsx`: 내부 상품 편집 양식 내보내기.
- `npm run data:import -- /절대/경로/products.xlsx`: 전체 상품표를 검증한 뒤 원자적으로 교체. 기존 주문이 참조하는 SKU 삭제는 거절합니다.
- `npm run db:backup -- /절대/경로/backup.sqlite`: SQLite 온라인 백업. 복구는 서버를 종료한 뒤 백업을 별도 경로에 두고 `DATABASE_PATH`로 지정합니다. 기존 파일을 덮어쓰지 않도록 새 백업 경로를 사용하세요.
- `npm run mcp`: MCP stdio 서버. 서버 출력은 JSON-RPC만 사용하며 로그는 stderr를 사용합니다.

DB 기본 경로는 `.local/inbyeol.sqlite`입니다. `DATABASE_PATH=:memory:`는 테스트·일회성 실행 전용이며 종료하면 자료가 사라집니다. 파일 DB는 재시작 후 보존됩니다. `.local`은 Git 제외 대상이며 파일 손실을 방지하려면 위 백업 명령을 사용합니다. WAL을 사용하므로 실행 중 DB 파일 하나만 복사하는 방식은 백업 절차가 아닙니다.

## 저장과 대화방 구분

SQLite의 `sources`, `records`는 판매자와 자료 종류로 구분합니다. 상품·정책·주문은 ID·원본 스냅샷을 보존하며 기존 주문 금액은 저장 당시 값을 읽습니다. 자료 적재로 샘플 재고를 다시 차감하지 않습니다. 스키마 초기화는 자동 수행하고 `schema_migrations`에 자료·대화 테이블 버전 1과 실행/도구 기록 테이블 버전 2, 주문 후보/멱등 명령/재저장 방지 표식 버전 3, 발송 이력/택배 열 설정/파일 스냅샷 버전 4를 기록합니다.

`판매자 → 고객 계정 → 대화방 → 메시지`로 구분합니다. 같은 고객도 `context_label`을 달리해 여러 방을 만들 수 있습니다. 방이 어느 주문을 뜻하는지는 모델이 임의 확정하지 않습니다. 분석에서 저장한 주문 후보는 방에 연결합니다. 방마다 활성 주문은 한 건이며 새 주문 상담은 새 방에서 시작합니다.

채팅 요청은 `conversation_id`가 있으면 그 방에 저장하고, 없으면 새 방을 만듭니다. 응답의 방 ID를 다음 요청에 넘겨야 이어집니다. 같은 판매자의 동일 `request_id`·동일 내용 재전송은 한 번만 저장합니다. 같은 ID로 내용·고객·방을 바꾸면 `409`로 거절합니다. 다른 판매자의 방은 `404`, 다른 고객을 기존 방에 쓰면 `403`입니다. 방 조회는 판매자 범위이며 메시지 조회는 최근 200개를 시간순으로 반환합니다. 수신 텍스트만 저장하고 첨부 원본은 저장하지 않습니다.

원문과 메시지는 SQLite에 보존되며 일반 로그에는 남기지 않습니다. 아직 보관·삭제 정책과 운영 인증을 갖추지 않았으므로 실제 고객 자료는 넣지 않습니다. 붙여넣은 텍스트의 `[판매자]` 같은 표기는 실제 발신자 권한을 증명하지 않습니다.

## 주문 저장·판매자 확정

`POST /api/orders/from-analysis`의 `{request_id}`로 판매자 소유의 성공한 분석을 저장합니다. 같은 요청 재전송은 같은 주문을 반환합니다. 정보가 부족하면 `draft`, 수령인·연락처·주소·입금자·상품·수량과 코드 견적에 문제가 없으면 `pending_payment`입니다. 우편번호는 선택이며 입력하면 5자리여야 합니다. 저장/수정은 재고를 예약하거나 차감하지 않습니다. 가격은 분석이 제안한 값을 믿지 않고 현재 `quote_order`로 다시 계산합니다.

`GET /api/orders`는 현재 판매자의 주문 후보와 과거 기록을 반환합니다. 웹에서 아이디·수령인·상태로 찾습니다. `PUT /api/orders/:id`는 `{expected_version,reviewed_snapshots:{products,policies},draft:{recipient,depositor_name,items:[{sku,quantity}]}}`로 미확정 주문을 수정하고 최신 견적을 저장합니다. 클라이언트가 금액을 보내 정할 수 없습니다.

`POST /api/orders/:id/confirm`은 `{command_id:UUID,expected_version,reviewed_snapshots:{products,policies},payment_checked:true,checked_amount_krw,checked_depositor_name,address_acknowledged:true}`를 받습니다. 은행에서 확인한 실제 금액·입금자명을 저장된 견적/입금자와 대조하고 배송지 수동 확인을 요구합니다. 현재 상품/정책·재고·마감·주문 버전을 다시 검사한 뒤 전 품목 수량 차감, 상태/버전/확정 시각/판매자 확인 기록과 멱등 결과를 하나의 `BEGIN IMMEDIATE` 트랜잭션으로 커밋합니다. 에이전트는 이 명령을 도구로 사용할 수 없습니다.

같은 명령 ID·같은 내용은 버전 검사보다 먼저 기존 결과를 반환합니다. 같은 ID의 다른 내용은 `409`, 이미 확정된 주문에 새 ID를 보내도 재차감하지 않습니다. 통신 결과를 못 받으면 웹은 같은 ID로 재시도합니다. 실패/품절/버전 변경은 부분 차감 없이 거절합니다. 가격/정책/재고가 바뀌면 최신 견적을 다시 저장하고 확인해야 합니다. 확정 주문과 과거 주문은 이 수정 경로에서 잠깁니다. 과거 단가·상품 표시·총액은 저장 당시 값을 유지합니다.

`DELETE /api/orders/:id`의 `{expected_version}`은 해당 주문 기록을 삭제합니다. **삭제·전체 주문 초기화는 이미 차감된 재고를 복원하지 않습니다.** 재승인 방지를 위해 요청 ID·주문 ID 표식은 남으며 삭제한 분석을 다시 저장하면 `404`입니다. 환불/취소의 재고 복원 기능이 아닙니다. 저장 시 원문은 대화 영역에, 주문 정보는 주문 영역에 각각 보존합니다.

## 발송·송장 기록과 정정

`GET /api/orders/:id/shipments`는 판매자 소유 주문의 `events[]`를 반환합니다. 과거 JSON 주문도 같은 서비스에서 처리합니다. 과거 주문을 별도 관리 주문으로 복제하지 않습니다. 새 관리 주문의 발송·정정도 `search_orders`에서 최신 저장 송장/발송일로 조회됩니다. 실시간 배송 상태를 확인한 것은 아닙니다.

`POST /api/orders/:id/shipments`는 `{command_id,operation,expected_version,carrier,tracking_number,shipped_at,correction_reason?}`를 받습니다. `operation`은 `register_shipment|update_shipment`입니다. 최초 등록은 `confirmed`, 정정은 `shipped`만 허용하며 정정 사유는 공백 제거 후 1~1,000자입니다. 택배사·송장은 1~100자이고 송장의 공백은 제거하되 앞자리 0을 보존합니다. 택배사별 실제 번호 유효성/존재는 검증하지 않습니다. 시간대가 있는 발송 시각을 UTC로 정규화하고 `confirmed_at ≤ shipped_at ≤ 서버 현재 시각`을 확인합니다.

등록/정정은 주문 버전을 1 올리고, 송장·발송일·변경 전후·사유·판매자·기록 시각과 멱등 결과를 한 SQLite 트랜잭션에 저장합니다. 재고·금액·수령인·입금 확인 기록은 그대로입니다. 정정할 내용이 없는 요청도 거절합니다. 승인·발송·정정은 판매자 범위의 명령 키를 공유하며 다른 주문/작업/내용에 같은 키를 재사용하면 `409`입니다. 동일 정규화 요청 재전송은 현재 버전 검사 전에 원래 결과에 `replayed:true`만 붙여 반환합니다. 새 키로 최초 등록을 반복하면 이미 발송됐다고 거절합니다.

응답은 `{command_id,order_id,status:"shipped",version,replayed,order,event}`입니다. 웹은 결과 미확인 재시도에서 같은 키와 내용을 유지합니다. 실제 발송 확인은 웹 체크박스로 안내하며 서버는 인증된 판매자의 명령으로 처리합니다. 에이전트에는 쓰기 도구를 제공하지 않습니다.

## 택배용 공통 엑셀과 열 설정

사용자가 택배사 미정 상태에서 공통 발송명단/열 설정을 선택했습니다. 이 파일은 **실제 택배사 접수 프로그램의 업로드 호환성을 검증한 양식이 아닙니다.** 송장 자동 발급·택배 접수·실시간 조회는 실행하지 않습니다.

- `GET /api/parcel/template`: 현재 판매자 열 설정 `{version,template}`. 기본은 공통 발송명단 8열입니다. `PUT`은 `{version,template:{name,sheet_name,columns:[{field,header,required}]}}`로 저장하며 버전 충돌을 거절합니다. 열 이름·순서·포함 여부·필수값을 설정합니다. 수령인/연락처/주소 3열은 반드시 필수로 둡니다. 필드·열 이름은 중복될 수 없습니다.
- 필드는 `order_id,recipient_name,phone,postal_code,address,item_summary,total_krw,shipping_memo`입니다. 한 주문당 한 행, 확정 당시 상품 표시/수량·총액을 사용합니다. 배송메모는 내보내기 선택에서만 입력하며 주문의 승인된 수령 정보를 변경하지 않습니다. 확정 후 수령 정보 변경 기능은 제공하지 않으므로 필수 우편번호 등은 주문 확정 전에 수집해야 합니다.
- `POST /api/parcel/preview`: `{template_version,order_ids,notes:{주문ID:배송메모}}`. 최대 500건이고 기존 일반 JSON 본문 한도 64 KiB도 적용합니다. 확정·미발송이며 열 설정의 필수값을 충족하는 주문만 `rows`/`included_order_ids`에 넣고 나머지는 `excluded[{order_id,reason}]`로 돌려줍니다. 이전 내보내기 횟수·최근 시각과 최신 주문/열/내보내기 상태의 `fingerprint`를 포함합니다. 미리보기는 DB를 변경하지 않습니다.
- `POST /api/parcel/exports`: 위 선택에 `{command_id:UUID,fingerprint,acknowledge_repeat}`를 추가합니다. 검증된 미리보기와 현재 주문/발송/설정/이력을 다시 대조하고 파일용 행 스냅샷/템플릿/포함·제외/시각을 원자 저장합니다. 과거 내보낸 주문은 `acknowledge_repeat:true`가 필요합니다. 같은 요청 키/내용은 같은 `export_id`를 재사용하며 다른 내용은 `409`입니다.
- `GET /api/parcel/exports`: 판매자별 내보내기 메타데이터. `GET /api/parcel/exports/:id/file`은 저장한 스냅샷에서 XLSX를 재생성합니다. 주문이 나중에 발송/정정되거나 열 설정이 바뀌어도 기존 파일은 원래 내용입니다. 같은 파일 재다운로드는 새 내보내기 기록을 만들지 않습니다. UI는 중복 접수를 경고합니다.
- XLSX는 설정한 한 시트만 생성합니다. 전화·우편번호·송장은 문자열로 유지하고 고객 메모를 수식으로 만들지 않습니다. 금액은 원 단위 숫자입니다. 파일 생성/다운로드/재내보내기는 주문 상태·재고·금액을 변경하지 않습니다.
- 주문 한 건 삭제 시 해당 발송 이력/명령 결과를 삭제하고 그 주문을 담은 기존 택배 파일의 행 스냅샷을 폐기합니다. 메타데이터는 남겨 다른 주문의 중복 접수 경고를 유지하지만 해당 파일 재다운로드는 `409`입니다. 주문 전체 초기화는 발송 이력과 모든 택배 파일/이력도 삭제합니다. 상품/정책·채팅 초기화는 이 영역을 유지하며 택배 열 설정은 주문 초기화 후에도 유지됩니다.

## 웹 자료 관리·엑셀·독립 초기화

- `POST /api/resources/products` / `policies`: 기존 수정과 같은 `{snapshot_id,product}` 또는 `{snapshot_id,policy}` 계약으로 추가합니다. 상품·정책 ID와 모든 SKU는 고유합니다. 새 정책은 선택적 `title`을 지원합니다.
- `DELETE /api/resources/:kind/:id`: `{products,policies}` 스냅샷으로 삭제합니다. `kind`는 `products|policies`입니다. 상품 삭제는 그 상품의 구조화된 할인 정책도 제거하며 과거 주문·대화를 유지합니다.
- `GET /api/data/stats`: 상품·정책·주문·전체 방 건수입니다.
- `GET /api/data/export?format=xlsx|json`: 현재 판매자의 상품·정책·주문·대화·분석을 반출합니다. JSON은 자료 버전과 도구 실행 결과도 포함합니다. 비밀 키/인증 토큰은 없습니다. XLSX는 연락처·우편번호를 문자열로 유지하고 수식을 생성하지 않습니다. 32,767자 셀 한도를 넘는 기록은 잘라내지 않고 JSON 반출을 안내합니다. **택배 양식이 아닙니다.**
- `POST /api/data/import/preview`: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`의 원본 `.xlsx` 본문을 받습니다. 최대 2 MiB, 압축 해제 20 MiB/500항목, 시트당 10,000행/30열입니다. ZIP 선언 크기와 실제 제한 압축 해제, 수식/링크 셀, 스키마·중복·정책 호환성을 검사합니다. 열 목록/샘플 행/오류 행/추가·갱신 건수와 10분 유효 토큰을 반환하며 DB를 변경하지 않습니다. 서버 메모리에 최대 10개를 두며 재시작/초기화 시 없어집니다.
- `POST /api/data/import/apply`: `{token}`으로 미리보기를 적용합니다. 오류가 하나라도 있거나 자료 버전이 바뀌면 전부 거절합니다. 동일 상품 ID는 옵션 전체를 교체하고 파일에 없는 상품·정책은 유지합니다. `products`/`상품`, `policies`/`정책` 시트를 지원하며 내보낸 열과 상품명·가격·재고·색상·사이즈·판매마감 등 한글 별칭을 인식합니다. 상품/옵션 ID가 비었으면 상품명·색상·사이즈로 매칭/생성하며 동명 상품이 모호하면 ID를 요구합니다. 가격·재고·마감은 필수입니다. 수식은 값으로 붙여넣어야 합니다. **주문·대화·분석 시트는 가져오지 않습니다.**
- `POST /api/data/reset/:scope`: `{confirm:"초기화",snapshots:{products,policies,orders}}`. `catalog`는 상품/정책만 샘플 없이 비우며 `sources`를 유지해 재시작 후에도 빈 상태입니다. `orders`는 주문 기록만 비우며 재고를 복원하지 않습니다. `chats`는 전체 방·원문·분석·도구 기록과 별도 전용 Flue DB를 비웁니다. 기한이 남았거나 만료 시각을 알 수 없는 분석/실제 실행 중 호출이 있으면 `409`입니다. 재시작 후 만료된 중단 기록은 초기화할 수 있습니다. 채팅 초기화 중 새 쓰기는 잠깐 거절합니다. 앱 DB와 같은 경로·심볼릭 링크·Flue 전용 테이블 외의 DB는 삭제하지 않습니다. 외부 모델 서비스 기록·백업·다운로드 파일은 지우지 않습니다.

설정 화면은 대상 건수와 영향을 먼저 보여주고 ‘초기화’ 문구 입력을 받습니다. 실제 운영 데이터에 검증용 초기화를 실행하지 마세요. JSON 내보내기는 복구용 전체 DB 백업을 대신하지 않습니다. DB 복구에는 서버 종료 후 두 저장소의 백업/삭제 범위를 함께 판단해야 합니다.

## 로컬 API

로컬 실행에서는 `127.0.0.1:3000`에 바인딩합니다. `PORT`로 포트를 변경할 수 있습니다. Host와 Origin도 로컬·동일 출처로 제한하고, `LOCAL_API_TOKEN`을 설정하면 API와 `/health`에 Bearer 토큰 또는 HttpOnly 브라우저 세션이 필요합니다. 웹 셸(`/`)·해시 자산(`/assets/*`)과 세션 연결 경로는 공개되며 env·DB·소스는 정적으로 제공하지 않습니다. 컨테이너에서는 `APP_DEPLOYMENT=container`로 `0.0.0.0`에 바인딩하며 32자 이상 토큰이 필수입니다. `production`에서 container 설정이나 충분한 토큰이 없으면 시작을 거절합니다. 이 토큰은 단일 판매자 접근용이며 사용자별 운영 인증은 아닙니다.

- `GET /api/session`: 인증 여부·인증 필요 여부·현재 인증 방식만 반환합니다.
- `POST /api/session`: `{ "token":"LOCAL_API_TOKEN 값" }`으로 연결합니다. 8시간·HttpOnly·SameSite=Strict 쿠키(HTTPS에서는 Secure)를 발급하며 원래 토큰을 쿠키/응답에 넣지 않습니다. 최대 100개 세션을 메모리에 두고 재시작 시 만료합니다. `DELETE /api/session`은 연결을 해제합니다. 사용자별 운영 인증이 아닙니다.
- `GET /api/resources`: 현재 판매자의 상품·정책과 상품/정책/주문 스냅샷 ID. 주문 원본은 포함하지 않습니다.
- `PUT /api/resources/products/:id`: `{snapshot_id,product}`. 읽은 상품 스냅샷과 전체 상품 객체를 보내 기존 상품을 수정합니다. 상품 ID 변경은 거절하고 옵션 추가·삭제를 허용합니다. 필수값·숫자·중복·할인 호환성을 검증한 뒤 원자 저장합니다.
- `PUT /api/resources/policies/:id`: `{snapshot_id,policy}`. 기존 정책 종류를 보존하고 수정합니다. 배송비·할인 각각 최대 1개, 실제 할인 상품·최소 수량·할인액을 검증합니다. 배송비/할인/출고일 문구는 입력된 구조화 값으로 생성해 문구와 계산을 일치시킵니다. 일반 정책 문구는 직접 편집합니다.
- `GET /health`: 자료 서버 상태. `model_configured`와 `model_status`는 설정 유무만 표시하며 실제 공급자 접근 성공을 보증하지 않습니다. 모델 이름·실행 제한·TypeSafe 키 설정 여부만 추가로 반환하며 키 값은 포함하지 않습니다.
- `GET /api/tools`: 허용 도구 목록·입력 JSON Schema.
- `POST /api/tools/:name`: `{ "arguments": { ... }, "conversation_id": "선택 UUID" }`. 방이 있으면 해당 고객 범위의 주문만 조회합니다. 방 없는 호출은 로컬 판매자 관리용입니다.
- `POST /api/conversations`: `{ "customer_handle":"@sample.hana", "context_label":"가디건 주문" }` → `201`, `{conversation}`.
- `GET /api/conversations?customer_handle=@sample.hana`: 고객별 방 목록과 최신 요청의 요약 상태·유형·미리보기. 필터가 없으면 최근 생성 순으로 최대 100개.
- `GET /api/conversations/:id`: 방·최근 200메시지·최신 요청 ID/텍스트·실행 당시 스냅샷·실행 상태·분석·안전한 도구 진행 기록. 새로고침 복원과 2초 폴링에 사용합니다. 모델 호출을 시작하지 않습니다.
- `GET /api/conversations/:id/messages`: 해당 방의 최근 메시지.
- `POST /api/chat`: 아래 형식으로 수신하고 `{conversation_id,replayed,analysis,execution?}` 반환. `execution`은 실행 ID·Flue 모델 호출 수·도구 호출 ID·이름/성공 여부·running/succeeded/failed 상태를 포함하고 공급자 원문·키는 포함하지 않습니다.

```json
{
  "schema_version": "0.1",
  "request_id": "local-request-1",
  "customer_handle": "@sample.hana",
  "text": "니트 베이지 한 개 주문할게요"
}
```

`request_id`·`conversation_id`는 생략할 수 있습니다. `seller_id`·`reference_time`·`snapshots` 등 추가 필드는 거절합니다. 텍스트는 최대 20,000자, HTTP 본문 최대 64 KiB, 첨부 메타데이터는 `{type}` 형식 최대 5개입니다. 프로세스 전체 요청 한도는 분당 120건입니다. 모델 실행은 기본 60초, 최대 모델 호출 8회·도구 호출 16회(제출 포함), 모델당 출력 4,096토큰, 방 맥락 최근 40메시지·40,000자입니다. `.env.example`의 `AGENT_*` 설정으로 조절합니다. 맥락을 줄일 때 메시지를 통째로 제외하고 `context_truncated`를 전달합니다. 현재 메시지를 온전히 담지 못하면 `413`으로 거절합니다. 입력의 기준 시각·자료 버전은 서버가 결정하고 실행마다 고정합니다. 만료 시각은 서버의 실제 시각으로 별도 저장하므로 재시작·재전송으로 실행 시간이 늘어나지 않습니다.

잘못된 JSON `400`, 미인증 `401`, 고객/출처 불일치 `403`, 없는 방/도구/경로 `404`, 중복 요청 충돌 `409`, 과대 본문 `413`, JSON 이외 본문 `415`, 입력 검증 실패 `422`, 요청 한도 `429`, 내부 오류 `500`입니다. 오류는 `{error:{code,message,retryable}}`이고 내부 예외·키·원문을 노출하지 않습니다.

실행기·키가 준비되면 검증된 분석을 `200`으로 반환합니다. 키/실행기 미설정은 저장 후 `503`이며 같은 요청 ID로 설정 후 재시도할 수 있습니다. 모델·도구·출력 검증 실패는 `503`, 전체 시간 초과는 중단 후 `504`입니다. 종료된 성공·실패는 SQLite에 캐시되므로 같은 ID는 모델 호출 없이 재사용합니다. 실패한 분석을 새로 실행하려면 새 요청 ID를 사용하세요. 방 ID와 요청 ID를 보존하세요.

동일 방의 새 요청은 이전 실행 중 `409 / ROOM_BUSY`로 저장 전에 거절합니다. 동일 요청의 동시 전송은 같은 실행을 공유합니다. 다른 방은 독립적으로 실행합니다. 프로세스가 중단되면 같은 요청 ID·내용으로 재전송해 원래 만료 시각 안에서 기존 실행을 이어갈 수 있으며 스냅샷이나 호출 상한이 맞지 않으면 실패로 종료합니다. 기한이 지난 실행은 모델을 다시 호출하지 않고 `504`로 종료합니다. `request_id`를 생략하면 서버가 생성하므로 재전송 멱등성이 필요할 때는 직접 지정하세요.

사진만 있는 입력은 `200`이지만 상태 `unsupported`, 초안 `null`입니다. 어느 경로도 주문 확정·재고 변경·DM 발송을 수행하지 않습니다.

## 에이전트와 도구

`src/agent/runtime-agent.ts`는 Flue의 `useModel`·`useTool`로 업무 도구를 등록합니다. 실행 ID에서 판매자·방·고객·불변 맥락을 찾고 도구를 그 고객에 묶습니다. 요청마다 Flue 인스턴스를 분리하며 대화 연속성은 앱 DB의 같은 방 기록으로 제공합니다. 이전 assistant 메시지도 판매자 검토용 초안이며 승인 증거가 아닙니다.

`submit_analysis` 도구가 분석 스키마·요청 ID·고객·현재 자료 버전·실제로 조회한 상품/주문/정책 ID·조회 SKU·코드 견적 금액·수동 확인 경계를 검사합니다. 수령인·연락처·주소·우편번호·입금자명은 customer 원문에 존재해야 하며 assistant 초안의 값은 근거로 사용하지 않습니다. SKU·수량이 확정된 품목은 금액이 null이어도 일치하는 견적이 필요하고 품절·마감 경고를 human_review로 유지합니다. 원문에 등장한다는 검사만으로 최신 정정의 의미·수량 추출이나 답장 전체의 사실성까지 보증하지는 않습니다. 근거 없이 생성한 분석이나 일반 텍스트만 반환한 실행은 성공 처리하지 않습니다. 도구 결과와 실행 스냅샷은 앱 DB, Flue 대화·제출 상태는 별도 `.local/flue.sqlite`에 저장합니다. 두 파일에는 원문·도구 결과가 있으므로 모두 개인정보 저장소로 취급하세요.

TypeSafe의 `classify_inquiry({})`는 현재 방의 최근 6메시지로 문의 유형·확률·신뢰도를 반환합니다. [공식 API 계약](https://docs.typesafe.ai/introduction/quickstart)에 따라 호출하며 15초 제한과 응답 검증을 적용합니다. Jev는 승인 권한이 없으며 생성 모델이 조회 근거와 함께 검토합니다. TypeSafe 실패는 도구 실패로 남으며 검토하거나 다른 근거로 진행할 수 있습니다. 분류만 성공했다고 업무 도구 조회·답장 사실성까지 통과한 것은 아닙니다.

동일한 도구 구현을 HTTP·CLI·Flue 도구 정의·MCP가 사용합니다. 에이전트는 다음 도구로 자료를 조회하고 계산하도록 정의했습니다.

- `search_products`: 이름·별칭·SKU 검색. 별칭 충돌 후보를 모두 보존합니다.
- `get_policies`: 승인 정책 자료의 ID·규칙·버전 반환.
- `search_orders`: 고객 아이디·수령인 이름·주문 ID의 정확 일치 검색. 모호한 후보 목록에서는 연락처·주소를 제외합니다.
- `get_sales_calendar`: 최대 366일 범위의 자료상 공구 마감·출고 예정일. 외부 캘린더에 연결된 것은 아닙니다.
- `read_document`: `document_id=policy-guide`인 가상 판매 안내 파일만 실제 읽기. 임의 경로·평가 정답·환경 파일을 받지 않고 심볼릭 링크로 허용 범위를 벗어나면 거절합니다.
- `quote_order`: 양의 정수 수량, 실제 SKU 가격, 현재 지원 배송비·단일 할인 규칙으로 계산. 품절·마감·재고 부족을 별도로 표시하고 `can_confirm:false`를 유지합니다. 정책 구조가 지원 범위를 벗어나면 실패합니다.

MCP를 사용할 클라이언트는 `node_modules/.bin/tsx src/cli/main.ts mcp`를 저장소 루트에서 실행하도록 구성합니다. `AGENT_CONVERSATION_ID`에 판매자 소유 방 ID를 지정해야 MCP 주문 검색이 동작합니다. 미지정 시 다른 도구는 가능하지만 주문 검색은 `CONVERSATION_REQUIRED`입니다. HTTP 자료 도구의 방 없는 관리용 호출과 구분합니다. 현재 stdio 전송만 제공하며 OpenAI Agents API의 원격 MCP HTTP 연결은 후속입니다.

Flue용 도구는 `arguments` 객체 안에 원래 도구 입력을 넣습니다. 예: `search_products({arguments:{query:"가디건"}})`. 자동 테스트는 실제 Flue 실행기와 스크립트 모델로 도구 호출·검증 거절·한도·중단·재전송을 검사합니다. `npm run verify:agent`는 명시적 유료 실제 연결 검사이며 가상 주문의 맥락·62,000원 계산·TypeSafe 호출·중복 호출 방지·원본 보존을 확인합니다. 가상 40건/실제 50건 품질 평가는 별도입니다. 스키마·근거 ID·금액 검증만으로 답장 문장 전체의 사실성이나 추출 정확성을 보장하지 않습니다.

## 답장 복사 형식

`reply_draft`는 고객에게 보낼 본문만 반환합니다. 주문은 `[주문 상품]`·`[받는 분]`·`[결제 금액]`·`[안내]`를 빈 줄로 나누고, 항목을 한 줄씩 씁니다. 누락값은 `[확인 부탁드려요]`로 질문하며 문의·배송·클레임은 필요한 블록만 사용합니다. 표·Markdown 장식·JSON·판매자용 내부 메모는 본문에서 제외합니다. 입금 확인·주소 미검증 등 판매자 주의사항은 `review_items`에 보존합니다. 고객에게 필요한 불확실성 안내와 승인 경계는 유지합니다. 프롬프트 변경은 새 분석부터 적용되며 이미 저장한 답장을 소급 변경하지 않습니다.

## 의존성 호환성

Flue 2.3.0의 Pi 의존성은 최신 범위 해석 시 `Type` 내보내기 불일치가 있어 Pi AI/Core를 1.1.0으로 고정했습니다. Flue 하위 MCP 클라이언트는 2.4.0, minimatch 7~10 범위는 11.0.4, ExcelJS의 UUID는 11.1.1로 재정의해 설치 시 보고된 취약 범위를 피했습니다. 잠금 파일과 함께 관리하고 업데이트 시 Flue 모듈 가져오기·도구 정의·MCP·XLSX 테스트를 다시 실행합니다.

## 엑셀 자료와 현재 한계

판매자는 내보낸 `products.xlsx`의 `products` 시트를 편집할 수 있습니다. SKU마다 한 행이며 공통 상품 정보는 동일하게 유지합니다. 별칭은 `|`로 구분하고 금액·재고는 숫자, 날짜는 시간대를 포함한 텍스트로 입력합니다. 빈 소재·실측은 모르는 값으로 보존합니다. 열 이름·순서는 바꾸지 않습니다. 파일 최대 2 MiB·10,000행이며 수식·하이퍼링크 객체·중복 SKU·잘못된 값은 거절하고 기존 자료를 보존합니다.

이 파일은 내부 상품 편집 양식입니다. 실제 택배 업로드 양식이나 주문 송장 내보내기가 아닙니다. 실제 택배사 업로드 양식·업무 캘린더 OAuth·Sheets 연결·주소 API·다중 서버 운영은 미구현입니다. SQLite는 단일 프로세스/로컬 운영 준비용으로 선택했으며 다중 서버 공유 저장소로 쓰지 않습니다. 주문 확정/재고 AC-09~11은 자동 검사가 있으며 발송 AC-18~21도 서비스 동작을 검사합니다. 실제 택배사 업로드 AC-14는 별도입니다.


## Docker 실행

```sh
docker compose up -d --build
docker compose logs --tail=20 api
docker compose down
```

`.env.local`을 실행 시 주입하며 이미지 빌드에는 포함하지 않습니다. `LOCAL_API_TOKEN`은 32자 이상 무작위 값이어야 합니다. 예를 들어 `openssl rand -hex 32`의 결과를 로컬 env에 저장하고 채팅·로그·Git에 공유하지 마세요. API는 `Authorization: Bearer <LOCAL_API_TOKEN>`으로 호출하거나 웹 연결 화면에서 같은 토큰으로 세션을 발급받습니다. 웹과 API는 `http://127.0.0.1:3000`에서 함께 제공합니다. 토큰을 만들거나 바꾸면 클라이언트도 같은 값을 사용해야 합니다.

Compose는 `NODE_ENV=production`, `APP_DEPLOYMENT=container`, `/app/.local/inbyeol.sqlite`와 `/app/.local/flue.sqlite`를 지정합니다. 단일 Node 프로세스, 비특권 사용자, 읽기 전용 루트와 쓰기 가능한 영속 볼륨으로 실행하며 호스트 포트는 `127.0.0.1:3000`입니다. 시작 시 샘플 seed는 자료가 없는 판매자 영역에만 적용됩니다. 실제 서버 공개에는 별도 HTTPS와 사용자별 인증·보관 정책이 필요합니다. Cloudflare 배포나 Gateway 라우팅은 이 Compose에 포함하지 않습니다.

`docker compose restart api`와 `down` 후 재실행에도 볼륨이 남습니다. **`docker compose down -v`는 DB를 삭제합니다.** 개발자의 로컬 `.local/`과 Docker 볼륨은 별도 저장소입니다. 동시에 여러 복제본이 같은 DB를 쓰는 배포는 지원하지 않습니다.

앱 DB 온라인 백업은 기존 `db:backup` 명령을 사용합니다. 컨테이너 전체 복구용으로는 요청을 멈추고 `docker compose stop api` 후 볼륨의 두 DB와 남은 WAL/SHM을 함께 복사하세요. 새 빈 볼륨에 같은 소유권으로 복원하고 해당 Flue 버전으로 재실행합니다. 앱 DB만 복구하면 진행 중 Flue 실행을 이어갈 수 없으므로 완료된 기록 복구와 실행 복구를 구분하세요.

## Cloudflare 설정 상태

공식 [agent setup 지침](https://developers.cloudflare.com/agent-setup/prompt.md)에 따라 개발 환경의 Cloudflare 스킬·MCP 로그인·CLI 인증을 설정했습니다. 이는 저장소나 Docker 이미지에 로그인 토큰을 저장하는 절차가 아닙니다. 계정의 기본 AI Gateway를 확인했지만 저장된 BYOK 공급자 키는 없었습니다. 현재 앱은 OpenAI·TypeSafe 키를 env에서 직접 읽으며 Cloudflare MCP OAuth 토큰을 재사용하지 않습니다. Gateway용 변수는 예약된 설정이고 실제 추론 라우팅은 아직 연결하지 않았습니다.

## 웹 개발 프록시

`npm run dev`와 `npm run web:dev`를 별도 터미널에서 실행합니다. Vite는 `/api`·`/health`를 루프백 API로 프록시하며 서버 프로세스에서만 env 토큰을 붙입니다. 원래 localhost/127.0.0.1의 개발 서버 포트(기본 5173) Host와 동일 출처 Origin을 검사한 후 API 출처로 변환합니다. 브라우저에 Provider 키·연결 토큰을 주입하지 않으며 env·DB 파일 제공도 거절합니다. 두 프로세스는 같은 `PORT`를 사용해야 합니다. 프록시는 개발 서버 전용이며 외부에 공개하지 않습니다.

빌드 웹은 `npm run build && npm run web:build && npm start`로 Hono에서 제공하며 Docker도 같은 자산을 포함합니다. `web:preview`는 정적 확인용이고 API 프록시가 없습니다. 서버 연결 세션은 별도 DB 마이그레이션 없이 메모리에서 관리합니다.

## 자료 수정과 오래된 분석

웹 폼의 상품명·별칭·소재·기존 실측·판매 마감·기존 옵션의 색상/크기/가격/재고와 판매 정책을 수정할 수 있습니다. 신규 상품/옵션/정책 생성·삭제와 상품/정책 XLSX 미리보기/가져오기도 웹에서 제공합니다. 신규 실측 항목 추가는 폼에서 지원하지 않으며 상품 XLSX의 measurements_cm JSON으로 지정할 수 있습니다. 재고 입력은 판매자 자료 정정이며 주문 확정에 따른 재고 차감이 아닙니다.

상품/정책 수정은 `BEGIN IMMEDIATE` 안에서 판매자·ID·자료 버전을 검사하고 저장합니다. 오래된 창은 `409 / STALE_VERSION`으로 거절하며 입력은 유지합니다. 최신 자료로 다시 열기는 사용자가 선택합니다. 스키마 마이그레이션 없이 기존 records/sources를 사용하고 과거 주문 금액·주문 상태는 바꾸지 않습니다. 에이전트에는 수정 도구를 노출하지 않습니다.

완료된 분석은 실행 당시의 자료 버전을 보존합니다. 수정 후 오래된 답장을 경고하고 복사를 막으며, 복사 직전 서버 버전을 다시 조회해 다른 창의 수정도 확인합니다. 최신 자료로 재분석은 새 요청 ID로 모델을 다시 호출합니다. 분석 진행 중 자료가 바뀌면 기존 출력 검증이 STALE_VERSION으로 거절합니다. 저장된 답장을 소급 수정하지 않습니다.
