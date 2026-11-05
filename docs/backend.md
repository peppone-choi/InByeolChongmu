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

SQLite의 `sources`, `records`는 판매자와 자료 종류로 구분합니다. 상품·정책·주문은 ID·원본 스냅샷을 보존하며 기존 주문 금액은 저장 당시 값을 읽습니다. 자료 적재로 샘플 재고를 다시 차감하지 않습니다. 스키마 초기화는 자동 수행하고 `schema_migrations`에 버전 1을 기록합니다.

`판매자 → 고객 계정 → 대화방 → 메시지`로 구분합니다. 같은 고객도 `context_label`을 달리해 여러 방을 만들 수 있습니다. 방이 어느 주문을 뜻하는지는 모델이 임의 확정하지 않습니다. 주문 후보 선택·확정 기능은 후속입니다.

채팅 요청은 `conversation_id`가 있으면 그 방에 저장하고, 없으면 새 방을 만듭니다. 응답의 방 ID를 다음 요청에 넘겨야 이어집니다. 같은 판매자의 동일 `request_id`·동일 내용 재전송은 한 번만 저장합니다. 같은 ID로 내용·고객·방을 바꾸면 `409`로 거절합니다. 다른 판매자의 방은 `404`, 다른 고객을 기존 방에 쓰면 `403`입니다. 방 조회는 판매자 범위이며 메시지 조회는 최근 200개를 시간순으로 반환합니다. 수신 텍스트만 저장하고 첨부 원본은 저장하지 않습니다.

원문과 메시지는 SQLite에 보존되며 일반 로그에는 남기지 않습니다. 아직 보관·삭제 정책과 운영 인증을 갖추지 않았으므로 실제 고객 자료는 넣지 않습니다. 붙여넣은 텍스트의 `[판매자]` 같은 표기는 실제 발신자 권한을 증명하지 않습니다.

## 로컬 API

서버는 `127.0.0.1:3000`에만 바인딩합니다. `PORT`로 포트를 변경할 수 있습니다. Host와 Origin도 로컬·동일 출처로 제한하고, `LOCAL_API_TOKEN`을 설정하면 모든 경로에 `Authorization: Bearer ...`가 필요합니다. 컨테이너에서는 `APP_DEPLOYMENT=container`로 `0.0.0.0`에 바인딩하며 32자 이상 토큰이 필수입니다. `production`에서 container 설정이나 충분한 토큰이 없으면 시작을 거절합니다. 이 토큰은 단일 판매자 접근용이며 사용자별 운영 인증은 아닙니다.

- `GET /health`: 자료 서버 상태. `model_configured`와 `model_status`는 설정 유무만 표시하며 실제 공급자 접근 성공을 보증하지 않습니다.
- `GET /api/tools`: 허용 도구 목록·입력 JSON Schema.
- `POST /api/tools/:name`: `{ "arguments": { ... }, "conversation_id": "선택 UUID" }`. 방이 있으면 해당 고객 범위의 주문만 조회합니다. 방 없는 호출은 로컬 판매자 관리용입니다.
- `POST /api/conversations`: `{ "customer_handle":"@sample.hana", "context_label":"가디건 주문" }` → `201`, `{conversation}`.
- `GET /api/conversations?customer_handle=@sample.hana`: 고객별 방 목록. 필터가 없으면 최대 100개.
- `GET /api/conversations/:id/messages`: 해당 방의 최근 메시지.
- `POST /api/chat`: 아래 형식으로 수신하고 `{conversation_id,replayed,analysis,execution?}` 반환. `execution`은 실행 ID·Flue 모델 호출 수·도구 이름/성공 여부를 포함하고 공급자 원문·키는 포함하지 않습니다.

```json
{
  "schema_version": "0.1",
  "request_id": "local-request-1",
  "customer_handle": "@sample.hana",
  "text": "니트 베이지 한 개 주문할게요"
}
```

`request_id`·`conversation_id`는 생략할 수 있습니다. `seller_id`·`reference_time`·`snapshots` 등 추가 필드는 거절합니다. 텍스트는 최대 20,000자, HTTP 본문 최대 64 KiB, 첨부 메타데이터는 `{type}` 형식 최대 5개입니다. 프로세스 전체 요청 한도는 분당 120건입니다. 모델 실행은 기본 60초, 최대 모델 호출 8회·도구 호출 16회(제출 포함), 모델당 출력 4,096토큰, 방 맥락 최근 40메시지·40,000자입니다. `.env.example`의 `AGENT_*` 설정으로 조절합니다. 맥락을 줄일 때 메시지를 통째로 제외하고 `context_truncated`를 전달합니다. 현재 메시지를 온전히 담지 못하면 `413`으로 거절합니다. 입력의 기준 시각·자료 버전은 서버가 결정하고 실행마다 고정합니다.

잘못된 JSON `400`, 미인증 `401`, 고객/출처 불일치 `403`, 없는 방/도구/경로 `404`, 중복 요청 충돌 `409`, 과대 본문 `413`, JSON 이외 본문 `415`, 입력 검증 실패 `422`, 요청 한도 `429`, 내부 오류 `500`입니다. 오류는 `{error:{code,message,retryable}}`이고 내부 예외·키·원문을 노출하지 않습니다.

실행기·키가 준비되면 검증된 분석을 `200`으로 반환합니다. 키/실행기 미설정은 저장 후 `503`이며 같은 요청 ID로 설정 후 재시도할 수 있습니다. 모델·도구·출력 검증 실패는 `503`, 전체 시간 초과는 중단 후 `504`입니다. 종료된 성공·실패는 SQLite에 캐시되므로 같은 ID는 모델 호출 없이 재사용합니다. 실패한 분석을 새로 실행하려면 새 요청 ID를 사용하세요. 방 ID와 요청 ID를 보존하세요.

동일 방의 새 요청은 이전 실행 중 `409 / ROOM_BUSY`로 저장 전에 거절합니다. 동일 요청의 동시 전송은 같은 실행을 공유합니다. 다른 방은 독립적으로 실행합니다. 프로세스가 중단되면 같은 요청 ID·내용으로 재전송해 기존 실행을 이어갈 수 있으며 스냅샷이나 호출 상한이 맞지 않으면 실패로 종료합니다. `request_id`를 생략하면 서버가 생성하므로 재전송 멱등성이 필요할 때는 직접 지정하세요.

사진만 있는 입력은 `200`이지만 상태 `unsupported`, 초안 `null`입니다. 어느 경로도 주문 확정·재고 변경·DM 발송을 수행하지 않습니다.

## 에이전트와 도구

`src/agent/runtime-agent.ts`는 Flue의 `useModel`·`useTool`로 업무 도구를 등록합니다. 실행 ID에서 판매자·방·고객·불변 맥락을 찾고 도구를 그 고객에 묶습니다. 요청마다 Flue 인스턴스를 분리하며 대화 연속성은 앱 DB의 같은 방 기록으로 제공합니다. 이전 assistant 메시지도 판매자 검토용 초안이며 승인 증거가 아닙니다.

`submit_analysis` 도구가 분석 스키마·요청 ID·고객·현재 자료 버전·실제로 조회한 상품/주문/정책 ID·조회 SKU·코드 견적 금액·수동 확인 경계를 검사합니다. 근거 없이 생성한 분석이나 일반 텍스트만 반환한 실행은 성공 처리하지 않습니다. 도구 결과와 실행 스냅샷은 앱 DB, Flue 대화·제출 상태는 별도 `.local/flue.sqlite`에 저장합니다. 두 파일에는 원문·도구 결과가 있으므로 모두 개인정보 저장소로 취급하세요.

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

## 의존성 호환성

Flue 2.3.0의 Pi 의존성은 최신 범위 해석 시 `Type` 내보내기 불일치가 있어 Pi AI/Core를 1.1.0으로 고정했습니다. Flue 하위 MCP 클라이언트는 2.4.0, minimatch 7~10 범위는 11.0.4, ExcelJS의 UUID는 11.1.1로 재정의해 설치 시 보고된 취약 범위를 피했습니다. 잠금 파일과 함께 관리하고 업데이트 시 Flue 모듈 가져오기·도구 정의·MCP·XLSX 테스트를 다시 실행합니다.

## 엑셀 자료와 현재 한계

판매자는 내보낸 `products.xlsx`의 `products` 시트를 편집할 수 있습니다. SKU마다 한 행이며 공통 상품 정보는 동일하게 유지합니다. 별칭은 `|`로 구분하고 금액·재고는 숫자, 날짜는 시간대를 포함한 텍스트로 입력합니다. 빈 소재·실측은 모르는 값으로 보존합니다. 열 이름·순서는 바꾸지 않습니다. 파일 최대 2 MiB·10,000행이며 수식·하이퍼링크 객체·중복 SKU·잘못된 값은 거절하고 기존 자료를 보존합니다.

이 파일은 내부 상품 편집 양식입니다. 실제 택배 업로드 양식이나 주문 송장 내보내기가 아닙니다. 주문 확정·재고 차감·발송/정정·업무 캘린더 OAuth·Sheets 연결·주소 API·다중 서버 운영은 미구현입니다. SQLite는 단일 프로세스/로컬 운영 준비용으로 선택했으며 다중 서버 공유 저장소로 쓰지 않습니다. 거래 상태 전이의 AC-09~11·18~21은 아직 검증 대상 구현이 없습니다.


## Docker 실행

```sh
docker compose up -d --build
docker compose logs --tail=20 api
docker compose down
```

`.env.local`을 실행 시 주입하며 이미지 빌드에는 포함하지 않습니다. `LOCAL_API_TOKEN`은 32자 이상 무작위 값이어야 합니다. 예를 들어 `openssl rand -hex 32`의 결과를 로컬 env에 저장하고 채팅·로그·Git에 공유하지 마세요. 모든 경로는 `Authorization: Bearer <LOCAL_API_TOKEN>`으로 호출합니다. 토큰을 만들거나 바꾸면 클라이언트도 같은 값을 사용해야 합니다.

Compose는 `NODE_ENV=production`, `APP_DEPLOYMENT=container`, `/app/.local/inbyeol.sqlite`와 `/app/.local/flue.sqlite`를 지정합니다. 단일 Node 프로세스, 비특권 사용자, 읽기 전용 루트와 쓰기 가능한 영속 볼륨으로 실행하며 호스트 포트는 `127.0.0.1:3000`입니다. 시작 시 샘플 seed는 자료가 없는 판매자 영역에만 적용됩니다. 실제 서버 공개에는 별도 HTTPS와 사용자별 인증·보관 정책이 필요합니다. Cloudflare 배포나 Gateway 라우팅은 이 Compose에 포함하지 않습니다.

`docker compose restart api`와 `down` 후 재실행에도 볼륨이 남습니다. **`docker compose down -v`는 DB를 삭제합니다.** 개발자의 로컬 `.local/`과 Docker 볼륨은 별도 저장소입니다. 동시에 여러 복제본이 같은 DB를 쓰는 배포는 지원하지 않습니다.

앱 DB 온라인 백업은 기존 `db:backup` 명령을 사용합니다. 컨테이너 전체 복구용으로는 요청을 멈추고 `docker compose stop api` 후 볼륨의 두 DB와 남은 WAL/SHM을 함께 복사하세요. 새 빈 볼륨에 같은 소유권으로 복원하고 해당 Flue 버전으로 재실행합니다. 앱 DB만 복구하면 진행 중 Flue 실행을 이어갈 수 없으므로 완료된 기록 복구와 실행 복구를 구분하세요.

## Cloudflare 설정 상태

공식 [agent setup 지침](https://developers.cloudflare.com/agent-setup/prompt.md)에 따라 개발 환경의 Cloudflare 스킬·MCP 로그인·CLI 인증을 설정했습니다. 이는 저장소나 Docker 이미지에 로그인 토큰을 저장하는 절차가 아닙니다. 계정의 기본 AI Gateway를 확인했지만 저장된 BYOK 공급자 키는 없었습니다. 현재 앱은 OpenAI·TypeSafe 키를 env에서 직접 읽으며 Cloudflare MCP OAuth 토큰을 재사용하지 않습니다. Gateway용 변수는 예약된 설정이고 실제 추론 라우팅은 아직 연결하지 않았습니다.
