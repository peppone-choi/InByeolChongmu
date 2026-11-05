"""PR 검토에서 발견한 반례를 임시 자료에 재현하는 회귀 검사."""

import contextlib
import importlib.util
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("sample_validator", ROOT / "docs/samples/validate.py")
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


class SampleValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="inbyeol-regression-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copytree(ROOT / "docs", self.root / "docs", ignore=shutil.ignore_patterns("__pycache__"))
        for name in ("README.md", "AGENTS.md"):
            shutil.copyfile(ROOT / name, self.root / name)

    def edit(self, name, mutate):
        path = self.root / "docs/samples" / name
        data = json.loads(path.read_text(encoding="utf-8"))
        mutate(data)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def check(self):
        with contextlib.redirect_stdout(io.StringIO()):
            VALIDATOR.main(self.root)

    def reject(self, name, mutate, message):
        self.edit(name, mutate)
        with self.assertRaisesRegex(ValueError, message):
            self.check()

    def test_baseline(self):
        self.check()

    def test_reject_wrong_price_with_consistent_total(self):
        def mutate(data):
            data["order_draft"]["items"][0]["unit_price_krw"] = 1000
            data["order_draft"]["amounts"].update(subtotal_krw=32000, total_krw=32000)
        self.reject("analysis-example.json", mutate, "단가 불일치")

    def test_reject_unknown_sku(self):
        self.reject("analysis-example.json", lambda d: d["order_draft"]["items"][0].update(
            sku="NONEXISTENT-SKU"), "SKU 불일치")

    def test_reject_wrong_product_association(self):
        self.reject("analysis-example.json", lambda d: d["order_draft"]["items"][0].update(
            product_id="P003"), "상품 연결 오류")

    def test_reject_quantity_with_consistent_total(self):
        def mutate(data):
            data["order_draft"]["items"][0]["quantity"] = 2
            data["order_draft"]["amounts"].update(subtotal_krw=93000, total_krw=93000)
        self.reject("analysis-example.json", mutate, "수량 불일치")

    def test_reject_duplicate_items(self):
        self.reject("analysis-example.json", lambda d: d["order_draft"]["items"].append(
            dict(d["order_draft"]["items"][0])), "중복 sku")

    def test_allow_reordered_items(self):
        self.edit("analysis-example.json", lambda d: d["order_draft"]["items"].reverse())
        self.check()

    def test_reject_boolean_quantity(self):
        self.reject("analysis-example.json", lambda d: d["order_draft"]["items"][0].update(
            quantity=True), "정수 범위 오류")

    def test_reject_float_price(self):
        self.reject("analysis-example.json", lambda d: d["order_draft"]["items"][0].update(
            unit_price_krw=31000.0), "정수 범위 오류")

    def test_reject_bad_evidence_snapshot(self):
        self.reject("analysis-example.json", lambda d: d["evidence"][0].update(
            snapshot_id="products-unknown"), "근거 출처·스냅샷 오류")

    def test_allow_historical_shipping_discount_and_price(self):
        def mutate(data):
            order = data["orders"][1]
            order["items"][0]["unit_price_krw"] = 29000
            order["amounts"].update(subtotal_krw=29000, discount_krw=1000,
                                    shipping_fee_krw=2000, total_krw=30000)
        self.edit("orders.json", mutate)
        self.check()

    def test_reject_wrong_historical_total(self):
        self.reject("orders.json", lambda d: d["orders"][1]["amounts"].update(
            total_krw=33000), "주문 금액 오류")

    def test_reject_negative_historical_discount(self):
        self.reject("orders.json", lambda d: d["orders"][1]["amounts"].update(
            discount_krw=-1), "정수 범위 오류")

    def test_reject_excessive_historical_discount(self):
        self.reject("orders.json", lambda d: d["orders"][1]["amounts"].update(
            discount_krw=32000, total_krw=2000), "할인 범위 오류")

    def test_reject_empty_carrier_in_shipment_example(self):
        self.reject("shipment-example.json", lambda d: d["request"].update(carrier="  "), "발송 필수값")

    def test_reject_unknown_shipment_order(self):
        self.reject("shipment-example.json", lambda d: d["request"].update(order_id="UNKNOWN"), "주문 참조")

    def test_reject_stale_shipment_example(self):
        self.reject("shipment-example.json", lambda d: d["request"].update(expected_version=2), "버전 불일치")

    def test_reject_pending_shipment_example(self):
        self.reject("shipment-example.json", lambda d: d["request"].update(order_id="O-0004"), "확정 주문만")

    def test_reject_future_shipment(self):
        self.reject("shipment-example.json", lambda d: d["request"].update(
            shipped_at="2026-11-06T10:00:00+09:00"), "시각 범위 오류")

    def test_reject_timezone_missing(self):
        self.reject("shipment-example.json", lambda d: d["request"].update(
            shipped_at="2026-11-05T09:30:00"), "시간대 누락")

    def test_reject_shipment_stock_mutation(self):
        self.reject("shipment-example.json", lambda d: d.update(stock_mutation_allowed=True), "재고 변경 금지")

    def test_reject_float_shipment_response_version(self):
        self.reject("shipment-example.json", lambda d: d["expected_response"].update(version=2.0), "정수 범위 오류")

    def test_reject_numeric_shipment_replay_flag(self):
        self.reject("shipment-example.json", lambda d: d["expected_response"].update(replayed=0), "재실행 표시 오류")

    def test_reject_shipment_before_confirmation(self):
        self.reject("shipment-example.json", lambda d: d["request"].update(
            shipped_at="2026-11-03T09:30:00+09:00"), "시각 범위 오류")

    def test_reject_duplicate_product_sku(self):
        self.reject("products.json", lambda d: d["products"][0]["variants"][0].update(sku="K-CR"), "SKU 중복")

    def test_reject_broken_link(self):
        with (self.root / "README.md").open("a", encoding="utf-8") as output:
            output.write("\n[누락 문서](missing-document.md)\n")
        with self.assertRaisesRegex(ValueError, "깨진 링크"):
            self.check()


if __name__ == "__main__":
    unittest.main()
