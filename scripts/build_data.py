#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterator, List, Optional


ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
PROCESSED_DIR = DATA_DIR / "processed"

REQUIRED_SHEETS = [
    "BaseParam.csv",
    "Item.csv",
    "ClassJobCategory.csv",
    "ItemUICategory.csv",
    "EquipSlotCategory.csv",
    "ItemLevel.csv",
    "Materia.csv",
    "MateriaGrade.csv",
    "MateriaJoinRateGatherCraft.csv",
    "ItemAction.csv",
    "ItemFood.csv",
]

# Maps canonical slot names to the corresponding BaseParam slot modifier column
SLOT_TO_BASEPARAM_COL: Dict[str, str] = {
    "main_hand": "2HWpn<%>",
    "off_hand": "OH<%>",
    "head": "Head<%>",
    "body": "Chest<%>",
    "hands": "Hands<%>",
    "waist": "Waist<%>",
    "legs": "Legs<%>",
    "feet": "Feet<%>",
    "ears": "Earring<%>",
    "neck": "Necklace<%>",
    "wrists": "Bracelet<%>",
    "ring": "Ring<%>",
}

TRACKED_STATS = {
    "Gathering": "gathering",
    "Perception": "perception",
    "GP": "gp",
}

SLOT_ORDER = [
    "MainHand",
    "OffHand",
    "Head",
    "Body",
    "Gloves",
    "Waist",
    "Legs",
    "Feet",
    "Ears",
    "Neck",
    "Wrists",
    "FingerL",
    "FingerR",
    "SoulCrystal",
]

SLOT_NAME_MAP = {
    "MainHand": "main_hand",
    "OffHand": "off_hand",
    "Head": "head",
    "Body": "body",
    "Gloves": "hands",
    "Waist": "waist",
    "Legs": "legs",
    "Feet": "feet",
    "Ears": "ears",
    "Neck": "neck",
    "Wrists": "wrists",
    "FingerL": "ring",
    "FingerR": "ring",
    "SoulCrystal": "soul_crystal",
}

VALID_GEAR_SLOTS = {
    "main_hand",
    "off_hand",
    "head",
    "body",
    "hands",
    "legs",
    "feet",
    "ears",
    "neck",
    "wrists",
    "ring",
    "waist",
}

PARAM_PAIRS = 6
TRACKED_STAT_KEYS = ("gathering", "perception", "gp")
FOOD_ACTION_TYPE = 844
MEAL_UI_CATEGORY_NAME = "Meal"


def parse_bool(value: Optional[str]) -> bool:
    if value is None:
        return False
    text = value.strip().lower()
    return text in {"true", "1"}


def parse_int(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return int(value, 10)
    except ValueError:
        return None


def utc_iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class CsvSheet:
    path: Path

    def iter_rows(self) -> Iterator[Dict[str, str]]:
        with self.path.open("r", encoding="utf-8-sig", newline="") as fh:
            reader = csv.reader(fh)
            try:
                _sheet_header = next(reader)
                semantic_header = next(reader)
                _type_row = next(reader)
            except StopIteration as exc:
                raise RuntimeError(f"Sheet is missing expected header rows: {self.path}") from exc

            headers: List[str] = []
            for idx, col in enumerate(semantic_header):
                text = (col or "").strip()
                headers.append(text if text else f"__col_{idx}")

            for row in reader:
                if not row or all((cell or "").strip() == "" for cell in row):
                    continue

                data: Dict[str, str] = {}
                for idx, key in enumerate(headers):
                    data[key] = row[idx] if idx < len(row) else ""
                yield data


class BuildData:
    def __init__(
        self,
        data_dir: Path = DATA_DIR,
        processed_dir: Path = PROCESSED_DIR,
        validate: bool = True,
    ) -> None:
        self.data_dir = data_dir
        self.processed_dir = processed_dir
        self.validate_enabled = validate
        self.processed: Dict[str, dict] = {}

    def run(self) -> Dict[str, dict]:
        self._verify_required_sheets()
        self.processed_dir.mkdir(parents=True, exist_ok=True)

        base_params = self._build_base_params()
        item_level_table = self._build_item_level_table()
        class_jobs = self._build_class_job_categories()
        item_ui_categories = self._build_item_ui_categories()
        equip_slots = self._build_equip_slot_categories()
        item_index = self._build_item_index(item_ui_categories=item_ui_categories)

        gear = self._build_gear(
            base_params=base_params,
            item_level_table=item_level_table,
            class_jobs=class_jobs,
            item_ui_categories=item_ui_categories,
            equip_slots=equip_slots,
        )
        rules = self._build_rules()
        materia = self._build_materia(base_params=base_params, item_index=item_index, rules=rules)
        food = self._build_food(
            base_params=base_params,
            item_index=item_index,
            item_ui_categories=item_ui_categories,
        )

        self._write_json("base_params.json", base_params)
        self._write_json("gear.json", gear)
        self._write_json("rules.json", rules)
        self._write_json("materia.json", materia)
        self._write_json("food.json", food)

        self.processed = {
            "base_params": base_params,
            "gear": gear,
            "rules": rules,
            "materia": materia,
            "food": food,
        }

        if self.validate_enabled:
            self._validate()
        return self.processed

    def _sheet_path(self, name: str) -> Path:
        return self.data_dir / name

    def _verify_required_sheets(self) -> None:
        missing = [sheet for sheet in REQUIRED_SHEETS if not self._sheet_path(sheet).exists()]
        if missing:
            raise RuntimeError(f"Missing required data sheets: {', '.join(missing)}")

    def _write_json(self, name: str, payload: dict) -> None:
        path = self.processed_dir / name
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    def _build_base_params(self) -> dict:
        params = []
        tracked: Dict[str, int] = {}
        slot_modifiers: Dict[str, Dict[str, int]] = {}

        for row in CsvSheet(self._sheet_path("BaseParam.csv")).iter_rows():
            param_id = parse_int(row.get("#"))
            if not param_id:
                continue

            name = (row.get("Name") or "").strip()
            if not name:
                continue

            entry = {
                "id": param_id,
                "name": name,
                "packet_index": parse_int(row.get("PacketIndex")),
                "order_priority": parse_int(row.get("OrderPriority")),
            }
            params.append(entry)
            if name in TRACKED_STATS:
                stat_key = TRACKED_STATS[name]
                tracked[stat_key] = param_id
                slot_mods: Dict[str, int] = {}
                for slot, col_name in SLOT_TO_BASEPARAM_COL.items():
                    mod = parse_int(row.get(col_name))
                    slot_mods[slot] = mod if mod is not None else 0
                slot_modifiers[stat_key] = slot_mods

        params.sort(key=lambda item: item["id"])
        return {
            "generated_at_utc": utc_iso_now(),
            "tracked_stat_ids": tracked,
            "tracked_stat_slot_modifiers": slot_modifiers,
            "params": params,
        }

    def _build_item_level_table(self) -> Dict[int, Dict[str, int]]:
        """Returns {ilvl: {stat_key: coefficient}} for tracked stats."""
        table: Dict[int, Dict[str, int]] = {}
        for row in CsvSheet(self._sheet_path("ItemLevel.csv")).iter_rows():
            ilvl = parse_int(row.get("#"))
            if ilvl is None:
                continue
            entry: Dict[str, int] = {}
            for stat_name, stat_key in TRACKED_STATS.items():
                coeff = parse_int(row.get(stat_name))
                if coeff is not None:
                    entry[stat_key] = coeff
            if entry:
                table[ilvl] = entry
        return table

    def _build_class_job_categories(self) -> Dict[int, dict]:
        categories: Dict[int, dict] = {}
        for row in CsvSheet(self._sheet_path("ClassJobCategory.csv")).iter_rows():
            category_id = parse_int(row.get("#"))
            if category_id is None:
                continue

            categories[category_id] = {
                "id": category_id,
                "name": (row.get("Name") or "").strip(),
                "min": parse_bool(row.get("MIN")),
                "btn": parse_bool(row.get("BTN")),
                "fsh": parse_bool(row.get("FSH")),
            }
        return categories

    def _build_item_ui_categories(self) -> Dict[int, str]:
        categories: Dict[int, str] = {}
        for row in CsvSheet(self._sheet_path("ItemUICategory.csv")).iter_rows():
            category_id = parse_int(row.get("#"))
            if category_id is None:
                continue
            categories[category_id] = (row.get("Name") or "").strip()
        return categories

    def _build_item_index(self, item_ui_categories: Dict[int, str]) -> Dict[int, dict]:
        items: Dict[int, dict] = {}
        for row in CsvSheet(self._sheet_path("Item.csv")).iter_rows():
            item_id = parse_int(row.get("#"))
            if not item_id:
                continue
            item_ui_category_id = parse_int(row.get("ItemUICategory"))
            items[item_id] = {
                "id": item_id,
                "name": (row.get("Name") or "").strip(),
                "icon_id": parse_int(row.get("Icon")) or 0,
                "item_level": parse_int(row.get("Level{Item}")),
                "equip_level": parse_int(row.get("Level{Equip}")),
                "item_ui_category_id": item_ui_category_id,
                "item_ui_category_name": item_ui_categories.get(item_ui_category_id),
                "can_be_hq": parse_bool(row.get("CanBeHq")),
                "item_action_id": parse_int(row.get("ItemAction")),
            }
        return items

    def _build_equip_slot_categories(self) -> Dict[int, dict]:
        slot_map: Dict[int, dict] = {}
        for row in CsvSheet(self._sheet_path("EquipSlotCategory.csv")).iter_rows():
            slot_id = parse_int(row.get("#"))
            if slot_id is None:
                continue

            active = [slot for slot in SLOT_ORDER if parse_bool(row.get(slot))]
            canonical = self._map_canonical_slot(active)
            slot_map[slot_id] = {
                "id": slot_id,
                "active_slot_keys": active,
                "canonical_slot": canonical,
            }
        return slot_map

    @staticmethod
    def _map_canonical_slot(active_slot_keys: List[str]) -> Optional[str]:
        if not active_slot_keys:
            return None
        if any(slot.startswith("Finger") for slot in active_slot_keys):
            return "ring"
        return SLOT_NAME_MAP.get(active_slot_keys[0])

    def _build_gear(
        self,
        base_params: dict,
        item_level_table: Dict[int, Dict[str, int]],
        class_jobs: Dict[int, dict],
        item_ui_categories: Dict[int, str],
        equip_slots: Dict[int, dict],
    ) -> dict:
        tracked_ids: Dict[str, int] = base_params["tracked_stat_ids"]
        tracked_names: Dict[int, str] = {value: key for key, value in tracked_ids.items()}
        slot_modifiers: Dict[str, Dict[str, int]] = base_params["tracked_stat_slot_modifiers"]

        rows = []
        for row in CsvSheet(self._sheet_path("Item.csv")).iter_rows():
            normalized = self._normalize_item_row(
                row=row,
                class_jobs=class_jobs,
                item_ui_categories=item_ui_categories,
                equip_slots=equip_slots,
                tracked_ids=tracked_ids,
                tracked_names=tracked_names,
                item_level_table=item_level_table,
                slot_modifiers=slot_modifiers,
            )
            if normalized is not None:
                rows.append(normalized)

        rows.sort(key=lambda item: (item["slot"], item["name"], item["id"]))
        return {
            "generated_at_utc": utc_iso_now(),
            "total_rows": len(rows),
            "rows": rows,
        }

    def _normalize_item_row(
        self,
        row: Dict[str, str],
        class_jobs: Dict[int, dict],
        item_ui_categories: Dict[int, str],
        equip_slots: Dict[int, dict],
        tracked_ids: Dict[str, int],
        tracked_names: Dict[int, str],
        item_level_table: Dict[int, Dict[str, int]],
        slot_modifiers: Dict[str, Dict[str, int]],
    ) -> Optional[dict]:
        item_id = parse_int(row.get("#"))
        if not item_id:
            return None

        name = (row.get("Name") or "").strip()
        if not name:
            return None

        equip_level = parse_int(row.get("Level{Equip}"))
        if equip_level is None or equip_level <= 0:
            return None

        class_job_category_id = parse_int(row.get("ClassJobCategory"))
        class_job = class_jobs.get(class_job_category_id)
        if not class_job:
            return None
        if not (class_job["min"] or class_job["btn"] or class_job["fsh"]):
            return None

        equip_slot_category_id = parse_int(row.get("EquipSlotCategory"))
        equip_slot = equip_slots.get(equip_slot_category_id)
        if not equip_slot:
            return None
        slot = equip_slot["canonical_slot"]
        if slot not in VALID_GEAR_SLOTS:
            return None

        item_ui_category_id = parse_int(row.get("ItemUICategory"))
        item_level = parse_int(row.get("Level{Item}"))
        can_be_hq = parse_bool(row.get("CanBeHq"))

        tracked_base_stats = self._extract_param_pairs(
            row=row,
            param_col_template="BaseParam[{idx}]",
            value_col_template="BaseParamValue[{idx}]",
            tracked_names=tracked_names,
        )
        tracked_special_stats = self._extract_param_pairs(
            row=row,
            param_col_template="BaseParam{{Special}}[{idx}]",
            value_col_template="BaseParamValue{{Special}}[{idx}]",
            tracked_names=tracked_names,
        )
        tracked_meld_caps = self._compute_tracked_meld_caps(
            item_level=item_level,
            slot=slot,
            tracked_base_stats=tracked_base_stats,
            tracked_special_stats=tracked_special_stats,
            can_be_hq=can_be_hq,
            item_level_table=item_level_table,
            slot_modifiers=slot_modifiers,
        )

        return {
            "id": item_id,
            "name": name,
            "icon_id": parse_int(row.get("Icon")) or 0,
            "slot": slot,
            "item_level": item_level,
            "equip_level": equip_level,
            "rarity": parse_int(row.get("Rarity")),
            "can_be_hq": can_be_hq,
            "class_job_category_id": class_job_category_id,
            "class_job_flags": {
                "min": class_job["min"],
                "btn": class_job["btn"],
                "fsh": class_job["fsh"],
            },
            "item_ui_category_id": item_ui_category_id,
            "item_ui_category_name": item_ui_categories.get(item_ui_category_id),
            "equip_slot_category_id": equip_slot_category_id,
            "guaranteed_materia_slots": parse_int(row.get("MateriaSlotCount")) or 0,
            "advanced_melding_permitted": parse_bool(row.get("IsAdvancedMeldingPermitted")),
            "tracked_base_stats": tracked_base_stats,
            "tracked_special_stats": tracked_special_stats,
            "tracked_meld_caps": tracked_meld_caps,
            "raw_special_bonus_ref": {
                "item_special_bonus_id": parse_int(row.get("ItemSpecialBonus")),
                "item_special_bonus_param": parse_int(row.get("ItemSpecialBonus{Param}")),
            },
            "source": {
                "tracked_stat_ids": tracked_ids,
            },
        }

    @staticmethod
    def _compute_tracked_meld_caps(
        item_level: Optional[int],
        slot: str,
        tracked_base_stats: dict,
        tracked_special_stats: dict,
        can_be_hq: bool,
        item_level_table: Dict[int, Dict[str, int]],
        slot_modifiers: Dict[str, Dict[str, int]],
    ) -> dict:
        """Compute per-stat materia caps (max additional stat from materia).

        total_cap = round(ItemLevel[ilvl][stat] * SlotModifier[stat][slot] / 1000)
        materia_cap = max(0, total_cap - effective_base_stat)
        where effective_base_stat uses HQ stats if the piece can be HQ.

        The game rounds the stat ceiling to the nearest whole point (ties up), not
        floor or ceil: e.g. 284.25 -> 284 but 568.5 -> 569. ceil over-counted the
        .25 cases and floor under-counted the .5 cases. We round-half-up with
        integer math ((x + 500) // 1000) because Python's round() uses banker's
        rounding (round(568.5) == 568), which would be wrong on the .5 ties.
        """
        ilvl_coeffs = item_level_table.get(item_level, {}) if item_level is not None else {}
        caps = {}
        for stat_key in TRACKED_STAT_KEYS:
            coeff = ilvl_coeffs.get(stat_key, 0)
            mod = slot_modifiers.get(stat_key, {}).get(slot, 0)
            if coeff <= 0 or mod <= 0:
                caps[stat_key] = 0
                continue
            total_cap = (coeff * mod + 500) // 1000
            base = tracked_base_stats.get(stat_key) or 0
            if can_be_hq:
                base += tracked_special_stats.get(stat_key) or 0
            caps[stat_key] = max(0, total_cap - base)
        return caps

    @staticmethod
    def _extract_param_pairs(
        row: Dict[str, str],
        param_col_template: str,
        value_col_template: str,
        tracked_names: Dict[int, str],
    ) -> dict:
        stats = {
            "gathering": 0,
            "perception": 0,
            "gp": 0,
        }

        for idx in range(PARAM_PAIRS):
            param_col = param_col_template.format(idx=idx)
            value_col = value_col_template.format(idx=idx)
            param_id = parse_int(row.get(param_col))
            value = parse_int(row.get(value_col))
            if param_id is None or value is None or value == 0:
                continue

            stat_key = tracked_names.get(param_id)
            if stat_key in stats:
                stats[stat_key] += value

        return stats

    def _build_rules(self) -> dict:
        rates_by_grade: Dict[int, dict] = {}

        for row in CsvSheet(self._sheet_path("MateriaGrade.csv")).iter_rows():
            key = parse_int(row.get("#"))
            if key is None:
                continue
            grade = key + 1
            nq_rates = [parse_int(row.get(f"__col_{i}")) or 0 for i in range(3, 7)]
            hq_rates = [parse_int(row.get(f"__col_{i}")) or 0 for i in range(7, 11)]
            allowed_slots = [idx for idx in range(4) if nq_rates[idx] > 0 or hq_rates[idx] > 0]

            rates_by_grade[grade] = {
                "grade": grade,
                "normal_meld_chance_percent": parse_int(row.get("__col_1")),
                "raw_threshold_value": parse_int(row.get("__col_2")),
                "overmeld_rates_nq": nq_rates,
                "overmeld_rates_hq": hq_rates,
                "overmeld_allowed_slots": allowed_slots,
            }

        join_rate_rows: Dict[int, dict] = {}
        join_rate_sheet = "MateriaJoinRateGatherCraft.csv"
        if not self._sheet_path(join_rate_sheet).exists():
            join_rate_sheet = "MateriaJoinRate.csv"

        for row in CsvSheet(self._sheet_path(join_rate_sheet)).iter_rows():
            key = parse_int(row.get("#"))
            if key is None:
                continue
            grade = key + 1
            join_nq = [parse_int(row.get(f"[NQ]Overmeld%Slot[{idx}]")) or 0 for idx in range(4)]
            join_hq = [parse_int(row.get(f"[HQ]Overmeld%Slot[{idx}]")) or 0 for idx in range(4)]
            join_rate_rows[grade] = {
                "overmeld_rates_nq": join_nq,
                "overmeld_rates_hq": join_hq,
            }
            if grade in rates_by_grade:
                rates_by_grade[grade]["join_rate_table"] = {
                    "overmeld_rates_nq": join_nq,
                    "overmeld_rates_hq": join_hq,
                }

        all_grades = sorted(rates_by_grade.keys())
        first_overmeld_only = [
            grade for grade in all_grades if rates_by_grade[grade]["overmeld_allowed_slots"] == [0]
        ]
        overmeld_forbidden = [
            grade for grade in all_grades if len(rates_by_grade[grade]["overmeld_allowed_slots"]) == 0
        ]

        return {
            "generated_at_utc": utc_iso_now(),
            "constants": {
                "max_total_materia_slots_per_piece": 5,
                "max_overmeld_slots_per_piece": 4,
            },
            "materia_grade_rules": [rates_by_grade[grade] for grade in all_grades],
            "grade_overmeld_patterns": {
                "first_overmeld_only_grades": first_overmeld_only,
                "overmeld_forbidden_grades": overmeld_forbidden,
            },
            "join_rate_sheet_used": join_rate_sheet,
        }

    def _build_materia(self, base_params: dict, item_index: Dict[int, dict], rules: dict) -> dict:
        tracked_ids: Dict[str, int] = base_params["tracked_stat_ids"]
        tracked_name_by_id = {value: key for key, value in tracked_ids.items()}

        grade_rules = {row["grade"]: row for row in rules["materia_grade_rules"]}
        rows = []

        for row in CsvSheet(self._sheet_path("Materia.csv")).iter_rows():
            group_id = parse_int(row.get("#"))
            base_param_id = parse_int(row.get("BaseParam"))
            if group_id is None or base_param_id is None:
                continue

            stat_key = tracked_name_by_id.get(base_param_id)
            if stat_key not in TRACKED_STAT_KEYS:
                continue

            for idx in range(16):
                item_id = parse_int(row.get(f"Item[{idx}]"))
                value = parse_int(row.get(f"Value[{idx}]"))
                if item_id is None or value is None or value == 0:
                    continue

                item = item_index.get(item_id)
                if not item:
                    continue

                grade = idx + 1
                grade_rule = grade_rules.get(grade, {})
                rows.append(
                    {
                        "materia_group_id": group_id,
                        "grade": grade,
                        "item_id": item_id,
                        "name": item.get("name"),
                        "item_level": item.get("item_level"),
                        "stat": stat_key,
                        "stat_id": base_param_id,
                        "value": value,
                        "overmeld_allowed_slots": grade_rule.get("overmeld_allowed_slots", []),
                        "overmeld_rates_nq": grade_rule.get("overmeld_rates_nq", [0, 0, 0, 0]),
                        "overmeld_rates_hq": grade_rule.get("overmeld_rates_hq", [0, 0, 0, 0]),
                    }
                )

        rows.sort(key=lambda item: (item["stat"], item["grade"], item["item_id"]))

        stat_summary: Dict[str, List[int]] = {key: [] for key in TRACKED_STAT_KEYS}
        for entry in rows:
            stat_summary[entry["stat"]].append(entry["grade"])
        for key in stat_summary:
            stat_summary[key] = sorted(set(stat_summary[key]))

        return {
            "generated_at_utc": utc_iso_now(),
            "tracked_stat_ids": tracked_ids,
            "stat_grade_summary": stat_summary,
            "total_rows": len(rows),
            "rows": rows,
        }

    def _build_food(
        self,
        base_params: dict,
        item_index: Dict[int, dict],
        item_ui_categories: Dict[int, str],
    ) -> dict:
        tracked_ids: Dict[str, int] = base_params["tracked_stat_ids"]
        tracked_name_by_id = {value: key for key, value in tracked_ids.items()}

        meal_ui_category_id = None
        for category_id, category_name in item_ui_categories.items():
            if category_name == MEAL_UI_CATEGORY_NAME:
                meal_ui_category_id = category_id
                break

        item_action_food_ref: Dict[int, int] = {}
        for row in CsvSheet(self._sheet_path("ItemAction.csv")).iter_rows():
            action_id = parse_int(row.get("#"))
            action_type = parse_int(row.get("Type"))
            if action_id is None or action_type != FOOD_ACTION_TYPE:
                continue
            food_row_id = parse_int(row.get("Data[1]"))
            if food_row_id is None:
                continue
            item_action_food_ref[action_id] = food_row_id

        item_food_rows: Dict[int, dict] = {}
        for row in CsvSheet(self._sheet_path("ItemFood.csv")).iter_rows():
            row_id = parse_int(row.get("#"))
            if row_id is None:
                continue
            item_food_rows[row_id] = row

        rows = []
        for item in item_index.values():
            if meal_ui_category_id is not None and item.get("item_ui_category_id") != meal_ui_category_id:
                continue

            action_id = item.get("item_action_id")
            if action_id is None or action_id not in item_action_food_ref:
                continue

            food_row_id = item_action_food_ref[action_id]
            food_row = item_food_rows.get(food_row_id)
            if not food_row:
                continue

            effects = []
            for idx in range(3):
                base_param_id = parse_int(food_row.get(f"BaseParam[{idx}]"))
                if base_param_id is None or base_param_id == 0:
                    continue

                stat_key = tracked_name_by_id.get(base_param_id)
                if stat_key not in TRACKED_STAT_KEYS:
                    continue

                effects.append(
                    {
                        "stat": stat_key,
                        "stat_id": base_param_id,
                        "is_relative": parse_bool(food_row.get(f"IsRelative[{idx}]")),
                        "nq_value": parse_int(food_row.get(f"Value[{idx}]")) or 0,
                        "nq_max": parse_int(food_row.get(f"Max[{idx}]")) or 0,
                        "hq_value": parse_int(food_row.get(f"Value{{HQ}}[{idx}]")) or 0,
                        "hq_max": parse_int(food_row.get(f"Max{{HQ}}[{idx}]")) or 0,
                    }
                )

            if not effects:
                continue

            rows.append(
                {
                    "item_id": item["id"],
                    "icon_id": item.get("icon_id", 0),
                    "name": item["name"],
                    "item_level": item["item_level"],
                    "can_be_hq": item["can_be_hq"],
                    "item_action_id": action_id,
                    "item_food_row_id": food_row_id,
                    "effects": effects,
                }
            )

        rows.sort(key=lambda item: (item["item_level"] or 0, item["name"], item["item_id"]))
        return {
            "generated_at_utc": utc_iso_now(),
            "tracked_stat_ids": tracked_ids,
            "food_action_type": FOOD_ACTION_TYPE,
            "meal_ui_category_id": meal_ui_category_id,
            "total_rows": len(rows),
            "rows": rows,
        }

    def _validate(self) -> None:
        tracked = self.processed["base_params"]["tracked_stat_ids"]
        missing = [key for key in TRACKED_STAT_KEYS if key not in tracked]
        if missing:
            raise RuntimeError(f"Missing tracked stat ids: {', '.join(missing)}")

        by_name = {row["name"]: row for row in self.processed["gear"]["rows"]}

        gold_thumb = by_name.get("Gold Thumb's Pickaxe")
        if gold_thumb is None:
            raise RuntimeError("Validation failed: Gold Thumb's Pickaxe missing from gear dataset")
        if not gold_thumb["advanced_melding_permitted"]:
            raise RuntimeError("Validation failed: Gold Thumb's Pickaxe should allow advanced melding")
        if gold_thumb["guaranteed_materia_slots"] != 1:
            raise RuntimeError(
                "Validation failed: Gold Thumb's Pickaxe expected guaranteed_materia_slots=1, "
                f"got {gold_thumb['guaranteed_materia_slots']!r}"
            )

        star_tech = by_name.get("Star Tech Pickaxe")
        if star_tech is None:
            raise RuntimeError("Validation failed: Star Tech Pickaxe missing from gear dataset")
        if star_tech["advanced_melding_permitted"]:
            raise RuntimeError("Validation failed: Star Tech Pickaxe should forbid advanced melding")
        if star_tech["guaranteed_materia_slots"] != 1:
            raise RuntimeError(
                "Validation failed: Star Tech Pickaxe expected guaranteed_materia_slots=1, "
                f"got {star_tech['guaranteed_materia_slots']!r}"
            )

        rules_by_grade = {row["grade"]: row for row in self.processed["rules"]["materia_grade_rules"]}
        for grade in (6, 8, 10, 12):
            rule = rules_by_grade.get(grade)
            if not rule:
                raise RuntimeError(f"Validation failed: missing materia rule for grade {grade}")
            if rule["overmeld_allowed_slots"] != [0]:
                raise RuntimeError(
                    "Validation failed: expected first-overmeld-only rule for grade "
                    f"{grade}, got {rule['overmeld_allowed_slots']}"
                )

        materia_rows = self.processed["materia"]["rows"]
        if not materia_rows:
            raise RuntimeError("Validation failed: materia dataset is empty")
        materia_stats = {row["stat"] for row in materia_rows}
        for stat_key in TRACKED_STAT_KEYS:
            if stat_key not in materia_stats:
                raise RuntimeError(f"Validation failed: missing materia rows for stat {stat_key}")

        food_rows = self.processed["food"]["rows"]
        if not food_rows:
            raise RuntimeError("Validation failed: food dataset is empty")
        food_stats = {effect["stat"] for row in food_rows for effect in row["effects"]}
        for stat_key in TRACKED_STAT_KEYS:
            if stat_key not in food_stats:
                raise RuntimeError(f"Validation failed: no food effects found for stat {stat_key}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build processed DoL solver data from raw CSV sheets.")
    parser.add_argument("--no-validate", action="store_true", help="Skip built-in validation checks.")
    args = parser.parse_args()

    builder = BuildData(validate=not args.no_validate)
    builder.run()
    print(f"Wrote {PROCESSED_DIR / 'base_params.json'}")
    print(f"Wrote {PROCESSED_DIR / 'gear.json'}")
    print(f"Wrote {PROCESSED_DIR / 'rules.json'}")
    print(f"Wrote {PROCESSED_DIR / 'materia.json'}")
    print(f"Wrote {PROCESSED_DIR / 'food.json'}")
    if not args.no_validate:
        print("Validation passed.")


if __name__ == "__main__":
    main()
