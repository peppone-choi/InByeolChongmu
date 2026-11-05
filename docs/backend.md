# 백엔드와 자료 도구

현재 구현은 로컬·가상 자료용입니다. Hono HTTP 서버, SQLite 파일 저장, 고객·대화방·메시지 분리, 읽기 도구 6개, MCP stdio 서버, Flue 도구 정의와 에이전트 팩터리를 제공합니다. 실제 모델 호출과 외부 서비스 인증·연동은 실행하지 않았습니다.

## 실행 환경과 명령

Node.js `26.5.1` 이상 `27` 미만, npm을 사용합니다. `.node-version`의 검증 버전은 `26.5.1`입니다. `node:sqlite`의 `DatabaseSync`를 사용하며 해당 모듈은 아직 안정화 완료 API가 아니므로 Node 업데이트 시 재검증합니다. 별도 DB 서버·Docker 설치는 필요 없습니다.

```sh
npm ci
cp .env.example .env.local
npm run db:seed
npm run dev
```

이미 `.env.local`이 있으면 복사로 덮어쓰지 마세요. `.env.local` → `.env` 순서로 읽고, 셸 환경 변수가 최종 우선입니다. 필요한 키 이름은 `.env.example`에만 빈 값으로 제공합니다. 실제 환경 파일은 Git에서 제외합니다. 이번 범위에서는 키를 채워도 모델 호출을 자동 시작하지 않습니다.

- `npm run build` / `npm start`: 컴파일 / 컴파일된 HTTP 서버 실행.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`: 타입·린트·포맷·동작 검사.
- `npm run db:seed`: 자료가 없는 판매자 영역에만 가상 자료를 적재합니다. 재시작이나 재실행으로 수정 자료를 덮어쓰지 않습니다.
- `npm run tools`: 도구 목록과 입력 스키마.
- `npm run tools -- search_products '{"query":"가디건"}'`: 실제 SQLite 상품 검색.
- `npm run tools -- quote_order '{"items":[{"sku":"K-BE","quantity":1},{"sku":"K-CR","quantity":1}]}'`: 코드 금액 계산.
- `npm run chat -- /절대/경로/request.json`: 채팅 JSON 파일 수신. 모델 미연결 시 메시지를 저장하고 오류 JSON 및 종료 코드 `2`를 반환합니다.
- `npm run data:export -- /절대/경로/products.xlsx`: 내부 상품 편집 양식 내보내기.
- `npm run data:import -- /절대/경로/products.xlsx`: 전체 상품표를 검증한 뒤 원자적으로 교체. 기존 주문이 참조하는 SKU 삭제는 거절합니다.
- `npm run db:backup -- /절대/경로/backup.sqlite`: SQLite 온라인 백업. 복구는 서버를 종료한 뒤 백업을 별도 경로에 두고 `DATABASE_PATH`로 지정합니다. 기존 파일을 덮어쓰지 않도록 새 백업 경로를 사용하세요.
- `npm run mcp`: MCP stdio 서버. 서버 출력은 JSON-RPC만 사용하며 로그는 stderr를 사용합니다.

DB 기본 경로는 `.local/inbyeol.sqlite`입니다. `DATABASE_PATH=:memory:`는 테스트·일회성 실행 전용이며 종료하면 자료가 사라집니다. 파일 DB는 재시작 후 보존됩니다. `.local`은 Git 제외 대상이며 파일 손실을 방지하려면 위 백업 명령을 사용합니다. WAL을 사용하므로 실행 중 DB 파일 하나만 복사하는 방식은 백업 절차가 아닙니다.

## 저장과 대화방 구분

SQLite의 `sources`, `records`는 판매자와 자료 종류로 구분합니다. 상품·정책·주문은 ID·원본 스냅샷을 보존하며 기존 주문 금액은 저장 당시 값을 읽습니다. 자료 적재로 샘플 재고를 다시 차감하지 않습니다. 스키마 초기화는 자동 수행하고 `schema_migrations`에 버전 1을 기록합니다.

`판매자 → 고객 계정 → 대화방 → 메시지`로 구분합니다. 같은 고객도 `context_label`을 달리해 여러 방을 만들 수 있습니다. 방이 어느 주문을 뜻하는지는 모델이 임의 확정하지 않습니다. 주문 후보 선택·확정 기능은 후속입니다.

채팅 요청은 `conversation_id`가 있으면 그 방에 저장하고, 없으면 새 방을 만듭니다. 응답의 방 ID를 다음 요청에 넘겨야 이어집니다. 같은 판매자의 동일 `request_id`·동일 내용 재전송은 한 번만 저장합니다. 같은 ID로 내용·고객·방을 바꾸면 `409`로 거절합니다. 다른 판매자의 방은 `404`, 다른 고객을 기존 방에 쓰면 `403`입니다. 방 조회는 판매자 범위이며 메시지 조회는 최근 200개를 시간순으로 반환합니다. 수신 텍스트만 저장하고 첨부 원본은 저장하지 않습니다.

원문과 메시지는 SQLite에 보존되며 일반 로그에는 남기지 않습니다. 아직 보관·삭제 정책과 운영 인증을 갖추지 않았으므로 실제 고객 자료는 넣지 않습니다. 붙여넣은 텍스트의 `[판매자]` 같은 표기는 실제 발신자 권한을 증명하지 않습니다.

## 로컬 API

서버는 `127.0.0.1:3000`에만 바인딩합니다. `PORT`로 포트를 변경할 수 있습니다. Host와 Origin도 로컬·동일 출처로 제한하고, `LOCAL_API_TOKEN`을 설정하면 모든 경로에 `Authorization: Bearer ...`가 필요합니다. `NODE_ENV=production` 실행은 거절합니다. 이 장치를 운영 인증이나 다중 사용자 접근 제어로 보고 외부에 공개하지 마세요.

- `GET /health`: 자료 서버 상태. `model_connected:false`를 별도 표시.
- `GET /api/tools`: 허용 도구 목록·입력 JSON Schema.
- `POST /api/tools/:name`: `{ "arguments": { ... }, "conversation_id": "선택 UUID" }`. 방이 있으면 해당 고객 범위의 주문만 조회합니다. 방 없는 호출은 로컬 판매자 관리용입니다.
- `POST /api/conversations`: `{ "customer_handle":"@sample.hana", "context_label":"가디건 주문" }` → `201`, `{conversation}`.
- `GET /api/conversations?customer_handle=@sample.hana`: 고객별 방 목록. 필터가 없으면 최대 100개.
- `GET /api/conversations/:id/messages`: 해당 방의 최근 메시지.
- `POST /api/chat`: 아래 형식으로 수신하고 `{conversation_id,replayed,analysis}` 반환.

```json
{
  "schema_version": "0.1",
  "request_id": "local-request-1",
  "customer_handle": "@sample.hana",
  "text": "니트 베이지 한 개 주문할게요"
}
```

`request_id`·`conversation_id`는 생략할 수 있습니다. `seller_id`·`reference_time`·`snapshots` 등 추가 필드는 거절합니다. 텍스트는 최대 20,000자, HTTP 본문 최대 64 KiB, 첨부 메타데이터는 `{type}` 형식 최대 5개입니다. 로컬 전체 요청 한도는 분당 120건이며 모델 실행 시간 제한은 실행기를 연결할 때 구현합니다.

잘못된 JSON `400`, 미인증 `401`, 고객/출처 불일치 `403`, 없는 방/도구/경로 `404`, 중복 요청 충돌 `409`, 과대 본문 `413`, JSON 이외 본문 `415`, 입력 검증 실패 `422`, 요청 한도 `429`, 내부 오류 `500`입니다. 오류는 `{error:{code,message,retryable}}`이고 내부 예외·키·원문을 노출하지 않습니다.

정상 텍스트 수신은 현재 `503`과 `MODEL_NOT_CONNECTED`를 반환합니다. 메시지는 저장되므로 반환된 방 ID와 요청 ID로 안전하게 재시도할 수 있습니다. 사진만 있는 입력은 `200`이지만 분석 상태는 `unsupported`, 초안은 `null`입니다. 어느 경우에도 주문·재고를 변경하지 않습니다.

## 에이전트와 도구

`src/agent/seller-agent.ts`는 Flue의 `useModel`·`useTool`로 업무 도구를 등록하는 에이전트 팩터리입니다. 판매자와 방을 검증해 도구를 해당 고객에 묶습니다. 실제 실행 루프는 아직 시작하지 않으며 임의 DM을 규칙이나 기대값으로 분석하는 우회 구현은 없습니다.

동일한 도구 구현을 HTTP·CLI·Flue 도구 정의·MCP가 사용합니다. 에이전트는 다음 도구로 자료를 조회하고 계산하도록 정의했습니다.

- `search_products`: 이름·별칭·SKU 검색. 별칭 충돌 후보를 모두 보존합니다.
- `get_policies`: 승인 정책 자료의 ID·규칙·버전 반환.
- `search_orders`: 고객 아이디·수령인 이름·주문 ID의 정확 일치 검색. 모호한 후보 목록에서는 연락처·주소를 제외합니다.
- `get_sales_calendar`: 최대 366일 범위의 자료상 공구 마감·출고 예정일. 외부 캘린더에 연결된 것은 아닙니다.
- `read_document`: `document_id=policy-guide`인 가상 판매 안내 파일만 실제 읽기. 임의 경로·평가 정답·환경 파일을 받지 않고 심볼릭 링크로 허용 범위를 벗어나면 거절합니다.
- `quote_order`: 양의 정수 수량, 실제 SKU 가격, 현재 지원 배송비·단일 할인 규칙으로 계산. 품절·마감·재고 부족을 별도로 표시하고 `can_confirm:false`를 유지합니다. 정책 구조가 지원 범위를 벗어나면 실패합니다.

MCP를 사용할 클라이언트는 `node_modules/.bin/tsx src/cli/main.ts mcp`를 저장소 루트에서 실행하도록 구성합니다. `AGENT_CONVERSATION_ID`에 판매자 소유 방 ID를 지정해야 MCP 주문 검색이 동작합니다. 미지정 시 다른 도구는 가능하지만 주문 검색은 `CONVERSATION_REQUIRED`입니다. HTTP 자료 도구의 방 없는 관리용 호출과 구분합니다. 현재 stdio 전송만 제공하며 OpenAI Agents API의 원격 MCP HTTP 연결은 후속입니다.

Flue용 도구는 `arguments` 객체 안에 원래 도구 입력을 넣습니다. 예: `search_products({arguments:{query:"가디건"}})`. 등록 정의 생성·검증과 MCP SDK의 실제 도구 호출은 키 없이 검사합니다. 모델이 어떤 도구를 고르는지와 답장 품질은 실제 모델 평가 전에는 검증 완료로 표시하지 않습니다.

## 의존성 호환성

Flue 2.3.0의 Pi 의존성은 최신 범위 해석 시 `Type` 내보내기 불일치가 있어 Pi AI/Core를 1.1.0으로 고정했습니다. Flue 하위 MCP 클라이언트는 2.4.0, minimatch 7~10 범위는 11.0.4, ExcelJS의 UUID는 11.1.1로 재정의해 설치 시 보고된 취약 범위를 피했습니다. 잠금 파일과 함께 관리하고 업데이트 시 Flue 모듈 가져오기·도구 정의·MCP·XLSX 테스트를 다시 실행합니다.

## 엑셀 자료와 현재 한계

판매자는 내보낸 `products.xlsx`의 `products` 시트를 편집할 수 있습니다. SKU마다 한 행이며 공통 상품 정보는 동일하게 유지합니다. 별칭은 `|`로 구분하고 금액·재고는 숫자, 날짜는 시간대를 포함한 텍스트로 입력합니다. 빈 소재·실측은 모르는 값으로 보존합니다. 열 이름·순서는 바꾸지 않습니다. 파일 최대 2 MiB·10,000행이며 수식·하이퍼링크 객체·중복 SKU·잘못된 값은 거절하고 기존 자료를 보존합니다.

이 파일은 내부 상품 편집 양식입니다. 실제 택배 업로드 양식이나 주문 송장 내보내기가 아닙니다. 주문 확정·재고 차감·발송/정정·업무 캘린더 OAuth·Sheets 연결·주소 API·다중 서버 운영·실제 모델 호출은 미구현입니다. SQLite는 단일 프로세스/로컬 운영 준비용으로 선택했으며 다중 서버 공유 저장소로 쓰지 않습니다. 거래 상태 전이의 AC-09~11·18~21은 아직 검증 대상 구현이 없습니다.
