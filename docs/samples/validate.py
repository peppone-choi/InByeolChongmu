"""가상 제작 자료의 일관성 검사. 앱이나 모델을 실행하지 않는다."""

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "docs" / "samples"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load(name):
    return json.loads((SAMPLES / name).read_text(encoding="utf-8"))


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


def main():
    products_file, policies_file, orders_file, cases_file = [
        load(name) for name in ("products.json", "policies.json", "orders.json", "dm-cases.json")
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
    for order in orders.values():
        items = []
        for item in order["items"]:
            require(item["sku"] in skus, "주문 SKU 참조 오류")
            require(type(item["quantity"]) is int and item["quantity"] > 0, "주문 수량 오류")
            items.append({**item, "product_id": skus[item["sku"]]["product_id"]})
        require(order["amounts"] == amounts(items, discount_rule, shipping),
                f"주문 금액 오류: {order['order_id']}")
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
            items = [{**skus[sku], "quantity": quantity} for sku, quantity
                     in zip(expected["matched_skus"], expected["quantities"])]
            require(amounts(items, discount_rule, shipping)["total_krw"] == expected["total_krw"],
                    f"{case['case_id']} 기대 금액 오류")
    require(len(request_ids) == len(set(request_ids)), "요청 ID 중복")

    example = load("analysis-example.json")
    expected = cases["DM-002"]["expected"]
    required_keys = {"schema_version", "request_id", "status", "classification", "priority",
                     "reply_draft", "order_candidates", "product_candidates", "matched_skus",
                     "order_draft", "missing_fields", "invalid_fields", "review_items",
                     "evidence", "state_mutation_allowed"}
    require(set(example) == required_keys, "완전한 출력의 필드 불일치")
    for key in ("classification", "status", "missing_fields", "matched_skus", "state_mutation_allowed"):
        require(example[key] == expected[key], f"출력 예시 {key} 불일치")
    require(example["request_id"] == cases["DM-002"]["input"]["request_id"], "예시 요청 불일치")
    require(example["order_draft"]["amounts"] == amounts(example["order_draft"]["items"],
            discount_rule, shipping), "출력 예시 금액 오류")
    evidence_ids = {item["source_id"] for item in example["evidence"]}
    require(set(expected["evidence_required"]) <= evidence_ids <= source_ids, "예시 근거 참조 오류")

    markdown = [ROOT / "AGENTS.md", ROOT / "README.md", *sorted((ROOT / "docs").rglob("*.md"))]
    for path in markdown:
        text = path.read_text(encoding="utf-8")
        require(text.endswith("\n"), f"마지막 줄바꿈 누락: {path}")
        require(all(line == line.rstrip() for line in text.splitlines()), f"줄 끝 공백: {path}")
        for target in re.findall(r"\]\(([^)]+)\)", text):
            if "://" not in target and not target.startswith("#"):
                require((path.parent / target.split("#")[0]).exists(), f"깨진 링크: {path}: {target}")
    print(f"자료 검사 통과: 상품 {len(products)}종 / SKU {len(skus)}개 / 주문 {len(orders)}건 / "
          f"DM {len(cases)}건 / 출력 예시 1건 / Markdown {len(markdown)}개")
    print("제품 기능·모델 품질·실제 주소·택배 업로드는 검사하지 않았습니다.")


if __name__ == "__main__":
    main()
