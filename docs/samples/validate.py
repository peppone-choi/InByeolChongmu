"""가상 제작 자료의 일관성 검사. 앱이나 모델을 실행하지 않는다."""

import json
import re
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "docs" / "samples"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load(name, samples=SAMPLES):
    return json.loads((samples / name).read_text(encoding="utf-8"))


def unique(rows, key):
    values = [row[key] for row in rows]
    require(len(values) == len(set(values)), f"중복 {key}")
    return {row[key]: row for row in rows}


def amounts(items, discount_rule, shipping):
    subtotal = sum(item["quantity"] * item["unit_price_krw"] for item in items)
    eligible = sum(item["quantity"] for item in items
                   if item["product_id"] == discount_rule["product_id"])
    discount = discount_rule["discount_krw"] if eligible >= discount_rule["minimum_quantity"] else 0
    return {"subtotal_krw": subtotal, "discount_krw": discount,
            "shipping_fee_krw": shipping, "total_krw": subtotal - discount + shipping}


def integer(value, minimum, label):
    require(type(value) is int and value >= minimum, f"정수 범위 오류: {label}")


def stored_amounts(items, saved, label):
    """확정 당시 금액의 산술만 검사하고 현재 정책은 적용하지 않는다."""
    require(isinstance(saved, dict) and set(saved) == {
        "subtotal_krw", "discount_krw", "shipping_fee_krw", "total_krw"
    }, f"금액 필드 오류: {label}")
    for item in items:
        integer(item["quantity"], 1, label)
        integer(item["unit_price_krw"], 0, label)
    for key, value in saved.items():
        integer(value, 0, f"{label}.{key}")
    subtotal = sum(item["quantity"] * item["unit_price_krw"] for item in items)
    require(saved["subtotal_krw"] == subtotal, f"상품 합계 오류: {label}")
    require(saved["discount_krw"] <= subtotal, f"할인 범위 오류: {label}")
    require(saved["total_krw"] == subtotal - saved["discount_krw"] + saved["shipping_fee_krw"],
            f"주문 금액 오류: {label}")


def timestamp(value):
    require(isinstance(value, str), "시각은 문자열이어야 합니다")
    parsed = datetime.fromisoformat(value)
    require(parsed.utcoffset() is not None, "시각의 시간대 누락")
    return parsed


def shipment_example(data, orders):
    """명령 예시의 계약만 확인한다. 상태 전이 서비스는 실행하지 않는다."""
    request, response = data["request"], data["expected_response"]
    require(set(request) == {"schema_version", "operation", "command_id", "order_id",
            "expected_version", "carrier", "tracking_number", "shipped_at"}, "발송 명령 필드 오류")
    require(request["schema_version"] == "0.1" and request["operation"] == "register_shipment",
            "발송 명령 종류 오류")
    require(request["order_id"] in orders, "발송 주문 참조 오류")
    before = orders[request["order_id"]]
    require(before["status"] == "confirmed", "발송 등록은 확정 주문만 가능")
    integer(request["expected_version"], 1, "발송 버전")
    require(request["expected_version"] == before["version"], "발송 버전 불일치")
    for key in ("command_id", "carrier", "tracking_number"):
        require(isinstance(request[key], str) and bool(request[key].strip()), f"발송 필수값 누락: {key}")
    require(request["tracking_number"].startswith("SAMPLE-"), "가상 발송 송장 표시 누락")
    require(timestamp(before["confirmed_at"]) <= timestamp(request["shipped_at"])
            <= timestamp(data["reference_time"]), "발송 시각 범위 오류")
    integer(response["version"], 1, "발송 응답 버전")
    require(response["replayed"] is False, "발송 응답 재실행 표시 오류")
    require(response == {"command_id": request["command_id"], "order_id": request["order_id"],
            "status": "shipped", "version": before["version"] + 1, "replayed": False},
            "발송 기대 응답 오류")
    require(data["stock_mutation_allowed"] is False, "발송 시 재고 변경 금지 누락")


def main(root=ROOT):
    root = Path(root)
    samples = root / "docs" / "samples"
    products_file, policies_file, orders_file, cases_file = [
        load(name, samples) for name in ("products.json", "policies.json", "orders.json", "dm-cases.json")
    ]
    for data in (products_file, policies_file, orders_file, cases_file):
        require(data["synthetic"] is True, "가상 자료 표시 누락")
        require(data["schema_version"] == "0.1", "계약 버전 불일치")
        require(data["reference_time"] == cases_file["reference_time"], "기준 시각 불일치")
        require(data["seller_id"] == cases_file["seller_id"], "판매자 불일치")

    products = unique(products_file["products"], "product_id")
    policies = unique(policies_file["policies"], "policy_id")
    orders = unique(orders_file["orders"], "order_id")
    cases = unique(cases_file["cases"], "case_id")
    skus = {}
    for product_id, product in products.items():
        for variant in product["variants"]:
            require(variant["sku"] not in skus, "SKU 중복")
            require(type(variant["stock_available"]) is int and variant["stock_available"] >= 0,
                    "가용 재고 오류")
            require(type(variant["unit_price_krw"]) is int and variant["unit_price_krw"] >= 0,
                    "가격 오류")
            skus[variant["sku"]] = {**variant, "product_id": product_id}

    discount_rule = policies["POL-DISCOUNT"]
    shipping = policies["POL-SHIPPING"]["shipping_fee_krw"]
    integer(shipping, 0, "배송비")
    integer(discount_rule["discount_krw"], 0, "할인")
    integer(discount_rule["minimum_quantity"], 1, "할인 수량")
    require(discount_rule["product_id"] in products, "할인 상품 참조 오류")
    for order in orders.values():
        integer(order["version"], 1, "주문 버전")
        items = []
        for item in order["items"]:
            require(item["sku"] in skus, "주문 SKU 참조 오류")
            require(type(item["quantity"]) is int and item["quantity"] > 0, "주문 수량 오류")
            items.append({**item, "product_id": skus[item["sku"]]["product_id"]})
        stored_amounts(items, order["amounts"], order["order_id"])
        require(order["status"] in {"draft", "pending_payment", "confirmed", "shipped", "cancelled"},
                "주문 상태 오류")
        require(order["customer_handle"].startswith("@sample."), "가상 아이디 표시 누락")
        if order["status"] == "shipped":
            require(order["tracking_number"].startswith("SAMPLE-"), "가상 송장 표시 누락")

    source_ids = set(products) | set(policies) | set(orders)
    classifications = {"product_inquiry", "order_request", "payment_claim", "order_lookup",
                       "claim", "unrelated", "unsupported", "invalid_input"}
    statuses = {"invalid_input", "unsupported", "human_review", "needs_info",
                "awaiting_payment", "ready_for_review", "ignored", "failed"}
    request_ids = []
    for case in cases.values():
        request, expected = case["input"], case["expected"]
        request_ids.append(request["request_id"])
        require(request["reference_time"] == cases_file["reference_time"], "DM 시각 불일치")
        require(request["seller_id"] == cases_file["seller_id"], "DM 판매자 불일치")
        require(request["snapshots"] == {"products": products_file["snapshot_id"],
                "policies": policies_file["snapshot_id"], "orders": orders_file["snapshot_id"]},
                "DM 스냅샷 참조 오류")
        require(expected["classification"] in classifications and expected["status"] in statuses,
                "DM 분류 또는 상태 오류")
        require(expected["state_mutation_allowed"] is False, "분석의 상태 변경 금지 누락")
        for key, allowed in (("matched_skus", skus), ("product_candidates", products),
                             ("order_candidates", orders), ("evidence_required", source_ids)):
            require(all(value in allowed for value in expected.get(key, [])),
                    f"{case['case_id']} {key} 참조 오류")
        if "total_krw" in expected:
            require(len(expected["matched_skus"]) == len(expected["quantities"]), "품목 수 불일치")
            for quantity in expected["quantities"]:
                integer(quantity, 1, "기대 수량")
            items = [{**skus[sku], "quantity": quantity} for sku, quantity
                     in zip(expected["matched_skus"], expected["quantities"])]
            require(amounts(items, discount_rule, shipping)["total_krw"] == expected["total_krw"],
                    f"{case['case_id']} 기대 금액 오류")
    require(len(request_ids) == len(set(request_ids)), "요청 ID 중복")

    example = load("analysis-example.json", samples)
    expected = cases["DM-002"]["expected"]
    required_keys = {"schema_version", "request_id", "status", "classification", "priority",
                     "reply_draft", "order_candidates", "product_candidates", "matched_skus",
                     "order_draft", "missing_fields", "invalid_fields", "review_items",
                     "evidence", "state_mutation_allowed"}
    require(set(example) == required_keys, "완전한 출력의 필드 불일치")
    for key in ("classification", "status", "missing_fields", "matched_skus", "state_mutation_allowed"):
        require(example[key] == expected[key], f"출력 예시 {key} 불일치")
    require(example["request_id"] == cases["DM-002"]["input"]["request_id"], "예시 요청 불일치")
    require(example["schema_version"] == "0.1", "출력 계약 버전 오류")
    require(example["state_mutation_allowed"] is False, "분석의 상태 변경 금지 오류")
    actual_items = example["order_draft"]["items"]
    actual = unique(actual_items, "sku")
    expected_quantities = dict(zip(expected["matched_skus"], expected["quantities"]))
    require(set(actual) == set(expected_quantities), "출력 예시 SKU 불일치")
    for sku, item in actual.items():
        require(item["product_id"] == skus[sku]["product_id"], "출력 예시 상품 연결 오류")
        integer(item["quantity"], 1, "출력 수량")
        integer(item["unit_price_krw"], 0, "출력 단가")
        require(item["quantity"] == expected_quantities[sku], "출력 예시 수량 불일치")
        require(item["unit_price_krw"] == skus[sku]["unit_price_krw"], "출력 예시 단가 불일치")
    stored_amounts(actual_items, example["order_draft"]["amounts"], "출력 예시")
    trusted_items = [{**skus[sku], "quantity": quantity} for sku, quantity in expected_quantities.items()]
    trusted_amounts = amounts(trusted_items, discount_rule, shipping)
    require(example["order_draft"]["amounts"] == trusted_amounts
            and trusted_amounts["total_krw"] == expected["total_krw"], "출력 예시 금액 오류")
    evidence_ids = {item["source_id"] for item in example["evidence"]}
    require(set(expected["evidence_required"]) <= evidence_ids <= source_ids, "예시 근거 참조 오류")
    sources = {"product": (products, products_file["snapshot_id"]),
               "policy": (policies, policies_file["snapshot_id"]),
               "order": (orders, orders_file["snapshot_id"])}
    for evidence in example["evidence"]:
        require(evidence["source_type"] in sources, "근거 유형 오류")
        ids, snapshot = sources[evidence["source_type"]]
        require(evidence["source_id"] in ids and evidence["snapshot_id"] == snapshot,
                "근거 출처·스냅샷 오류")
        require(isinstance(evidence["field_paths"], list) and bool(evidence["field_paths"])
                and all(isinstance(p, str) and p.strip() for p in evidence["field_paths"]), "근거 위치 누락")

    shipment = load("shipment-example.json", samples)
    require(shipment["synthetic"] is True, "가상 발송 표시 누락")
    for key in ("synthetic", "seller_id", "reference_time", "schema_version"):
        require(shipment[key] == cases_file[key], "발송 예시 메타데이터 불일치")
    shipment_example(shipment, orders)

    markdown = [root / "AGENTS.md", root / "README.md", *sorted((root / "docs").rglob("*.md"))]
    for path in markdown:
        text = path.read_text(encoding="utf-8")
        require(text.endswith("\n"), f"마지막 줄바꿈 누락: {path}")
        require(all(line == line.rstrip() for line in text.splitlines()), f"줄 끝 공백: {path}")
        for target in re.findall(r"\]\(([^)]+)\)", text):
            if "://" not in target and not target.startswith("#"):
                require((path.parent / target.split("#")[0]).exists(), f"깨진 링크: {path}: {target}")
    print(f"자료 검사 통과: 상품 {len(products)}종 / SKU {len(skus)}개 / 주문 {len(orders)}건 / "
          f"DM {len(cases)}건 / 분석 예시 1건 / 발송 계약 예시 1건 / Markdown {len(markdown)}개")
    print("제품 기능·모델 품질·실제 주소·택배 업로드는 검사하지 않았습니다.")


if __name__ == "__main__":
    main()
