from temp_roads_catalog import derive_temp_road_code


def test_derive_temp_road_code_from_object_name():
    assert derive_temp_road_code("TEMP_ROAD_2738", "Притрассовая дорога №18") == "АД18"
    assert derive_temp_road_code("TEMP_ROAD_3090", "Притрассовая дорога №3.2") == "АД3 №2"
    assert derive_temp_road_code("VPD_481", "Притрассовая дорога №4.8.1") == "АД4 №8.1"


def test_derive_temp_road_code_keeps_explicit_ad_suffix():
    assert derive_temp_road_code("", "АД8 №2") == "АД8 №2"
