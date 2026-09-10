--
-- PostgreSQL database dump
--

\restrict KFKbVwydybEk6uXyGtKK3Lm8cl90wFyiInmMm3c7TRTAu7PkEBQr1dosvuf5Jl5

-- Dumped from database version 16.15 (Debian 16.15-1.pgdg13+2)
-- Dumped by pg_dump version 16.15 (Debian 16.15-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: audit_backup; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA audit_backup;


--
-- Name: backup_yuri_max_cleanup_20260520t204635z; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA backup_yuri_max_cleanup_20260520t204635z;


--
-- Name: maintenance; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA maintenance;


--
-- Name: valera_backups; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA valera_backups;


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: format_route_pk(numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.format_route_pk(p_value numeric) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  v numeric := round(p_value::numeric, 2);
  pk integer;
  plus numeric;
  plus_text text;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;
  pk := floor(v / 100)::integer;
  plus := v - (pk * 100);
  IF plus = trunc(plus) THEN
    plus_text := lpad(plus::integer::text, 2, '0');
  ELSE
    plus_text := replace(to_char(plus, 'FM00D00'), '.', ',');
  END IF;
  RETURN 'ПК' || pk::text || '+' || plus_text;
END;
$$;


--
-- Name: format_route_pk_range(numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.format_route_pk_range(p_start numeric, p_end numeric) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN p_start IS NULL AND p_end IS NULL THEN NULL
    WHEN p_start IS NULL THEN public.format_route_pk(p_end)
    WHEN p_end IS NULL THEN public.format_route_pk(p_start)
    WHEN round(p_start::numeric, 2) = round(p_end::numeric, 2) THEN public.format_route_pk(p_start)
    ELSE public.format_route_pk(p_start) || ' - ' || public.format_route_pk(p_end)
  END
$$;


--
-- Name: recalc_segment_coords(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recalc_segment_coords() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    p1_lat DOUBLE PRECISION;
    p1_lng DOUBLE PRECISION;
    p2_lat DOUBLE PRECISION;
    p2_lng DOUBLE PRECISION;
    p1_pk INTEGER;
    p2_pk INTEGER;
    t DOUBLE PRECISION;
    pk_major INTEGER;
    pk_frac DOUBLE PRECISION;
BEGIN
    -- Start coordinates
    IF NEW.pk_start IS NOT NULL THEN
        pk_major := FLOOR(NEW.pk_start / 100);
        pk_frac := (NEW.pk_start::numeric % 100) / 100.0;
        
        SELECT latitude, longitude, pk_number INTO p1_lat, p1_lng, p1_pk
        FROM route_pickets WHERE pk_number <= pk_major ORDER BY pk_number DESC LIMIT 1;
        
        SELECT latitude, longitude, pk_number INTO p2_lat, p2_lng, p2_pk
        FROM route_pickets WHERE pk_number > pk_major ORDER BY pk_number ASC LIMIT 1;
        
        IF p1_lat IS NOT NULL AND p2_lat IS NOT NULL AND p2_pk > p1_pk THEN
            t := (pk_major + pk_frac - p1_pk)::double precision / (p2_pk - p1_pk);
            NEW.start_lat := p1_lat + (p2_lat - p1_lat) * t;
            NEW.start_lng := p1_lng + (p2_lng - p1_lng) * t;
        ELSIF p1_lat IS NOT NULL THEN
            NEW.start_lat := p1_lat;
            NEW.start_lng := p1_lng;
        END IF;
    END IF;

    -- End coordinates
    IF NEW.pk_end IS NOT NULL THEN
        pk_major := FLOOR(NEW.pk_end / 100);
        pk_frac := (NEW.pk_end::numeric % 100) / 100.0;
        
        SELECT latitude, longitude, pk_number INTO p1_lat, p1_lng, p1_pk
        FROM route_pickets WHERE pk_number <= pk_major ORDER BY pk_number DESC LIMIT 1;
        
        SELECT latitude, longitude, pk_number INTO p2_lat, p2_lng, p2_pk
        FROM route_pickets WHERE pk_number > pk_major ORDER BY pk_number ASC LIMIT 1;
        
        IF p1_lat IS NOT NULL AND p2_lat IS NOT NULL AND p2_pk > p1_pk THEN
            t := (pk_major + pk_frac - p1_pk)::double precision / (p2_pk - p1_pk);
            NEW.end_lat := p1_lat + (p2_lat - p1_lat) * t;
            NEW.end_lng := p1_lng + (p2_lng - p1_lng) * t;
        ELSIF p1_lat IS NOT NULL THEN
            NEW.end_lat := p1_lat;
            NEW.end_lng := p1_lng;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: sync_service_road_segments_from_settings(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_service_road_segments_from_settings() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM public.object_segments os
  USING public.objects o
  JOIN public.object_types ot ON ot.id=o.object_type_id
  WHERE os.object_id=o.id
    AND ot.code='SERVICE_ROAD';

  INSERT INTO public.object_segments (object_id, pk_start, pk_end, pk_raw_text, comment, review_tag)
  SELECT o.id,
         csv.pk_start,
         csv.pk_end,
         public.format_route_pk_range(csv.pk_start, csv.pk_end),
         'Сегмент содержания дорог по construction_section_versions.boundary_kind=temp_roads, section=' || cs.code,
         'service_road_temp_boundary_sync_trigger'
  FROM public.construction_section_versions csv
  JOIN public.construction_sections cs ON cs.id=csv.section_id
  JOIN public.objects o ON o.object_code = 'SERVICE_ROAD_' || cs.code
  JOIN public.object_types ot ON ot.id=o.object_type_id AND ot.code='SERVICE_ROAD'
  WHERE csv.is_current IS TRUE
    AND csv.boundary_kind='temp_roads';
  RETURN NULL;
END;
$$;


--
-- Name: sync_temp_road_object_segment(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_temp_road_object_segment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.object_id IS NOT NULL AND OLD.object_id IS DISTINCT FROM NEW.object_id THEN
    DELETE FROM public.object_segments WHERE object_id = OLD.object_id;
  END IF;
  IF NEW.object_id IS NOT NULL AND NEW.rail_start_pk IS NOT NULL AND NEW.rail_end_pk IS NOT NULL THEN
    DELETE FROM public.object_segments WHERE object_id = NEW.object_id;
    INSERT INTO public.object_segments (object_id, pk_start, pk_end, pk_raw_text, comment, review_tag)
    VALUES (
      NEW.object_id,
      NEW.rail_start_pk,
      NEW.rail_end_pk,
      public.format_route_pk_range(NEW.rail_start_pk, NEW.rail_end_pk),
      'Сегмент притрассовой дороги из temporary_roads.road_code=' || NEW.road_code || '; источник пикетажа: rail_start_pk/rail_end_pk',
      'temp_road_object_sync_trigger'
    );
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: sync_temporary_road_status_object_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_temporary_road_status_object_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT tr.object_id INTO NEW.object_id
  FROM public.temporary_roads tr
  WHERE tr.id = NEW.road_id;
  RETURN NEW;
END;
$$;


--
-- Name: touch_mainline_scheme_context_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_mainline_scheme_context_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: backup_daily_work_item_segments_main_oh_20260517_174052; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_daily_work_item_segments_main_oh_20260517_174052 (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: backup_daily_work_items_main_oh_20260517_174052; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_daily_work_items_main_oh_20260517_174052 (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: backup_dim_dorabotka_shpgs_aliases_20260811; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_dim_dorabotka_shpgs_aliases_20260811 (
    backed_up_at timestamp with time zone,
    id uuid,
    canonical_code text,
    alias_text text,
    kind text,
    notes text,
    created_at timestamp with time zone
);


--
-- Name: backup_dim_dorabotka_shpgs_daily_items_20260811; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_dim_dorabotka_shpgs_daily_items_20260811 (
    backed_up_at timestamp with time zone,
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: backup_dim_dorabotka_shpgs_segments_20260811; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_dim_dorabotka_shpgs_segments_20260811 (
    backed_up_at timestamp with time zone,
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: backup_dim_dorabotka_shpgs_work_types_20260811; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_dim_dorabotka_shpgs_work_types_20260811 (
    backed_up_at timestamp with time zone,
    id uuid,
    code character varying(100),
    name character varying(255),
    default_unit character varying(50),
    work_group character varying(100),
    is_active boolean,
    created_at timestamp with time zone,
    show_in_timeline boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: backup_dim_dorabotka_to_peremeshenie_shpgs_aliases_20260812; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_dim_dorabotka_to_peremeshenie_shpgs_aliases_20260812 (
    backed_up_at timestamp with time zone,
    id uuid,
    canonical_code text,
    alias_text text,
    kind text,
    notes text,
    created_at timestamp with time zone
);


--
-- Name: backup_dim_dorabotka_to_peremeshenie_shpgs_daily_items_20260812; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_dim_dorabotka_to_peremeshenie_shpgs_daily_items_20260812 (
    backed_up_at timestamp with time zone,
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: backup_dim_dorabotka_to_peremeshenie_shpgs_segments_20260812; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_dim_dorabotka_to_peremeshenie_shpgs_segments_20260812 (
    backed_up_at timestamp with time zone,
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: backup_dim_dorabotka_to_peremeshenie_shpgs_work_types_20260812; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_dim_dorabotka_to_peremeshenie_shpgs_work_types_20260812 (
    backed_up_at timestamp with time zone,
    id uuid,
    code character varying(100),
    name character varying(255),
    default_unit character varying(50),
    work_group character varying(100),
    is_active boolean,
    created_at timestamp with time zone,
    show_in_timeline boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: backup_material_movements_movement_type_20260609t_dbfix; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_material_movements_movement_type_20260609t_dbfix (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    material_id uuid,
    from_object_id uuid,
    to_object_id uuid,
    volume numeric(18,3),
    unit character varying(50),
    trip_count integer,
    movement_type character varying(50),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    equipment_type character varying(100),
    equipment_count integer,
    is_demo boolean,
    contractor_id uuid,
    review_tag text,
    haul_distance_km numeric,
    haul_distance_source text,
    from_object_type_code character varying(50),
    to_object_type_code character varying(50),
    expected_movement_type character varying,
    backup_created_at timestamp with time zone
);


--
-- Name: backup_object_segments_main_oh_20260517_174052; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_object_segments_main_oh_20260517_174052 (
    id uuid,
    object_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text
);


--
-- Name: backup_objects_main_oh_20260517_174052; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_objects_main_oh_20260517_174052 (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: backup_project_work_item_segments_main_oh_20260517_174052; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_project_work_item_segments_main_oh_20260517_174052 (
    id uuid,
    project_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    comment text,
    created_at timestamp with time zone,
    pk_raw_text text,
    volume_segment numeric
);


--
-- Name: backup_project_work_items_main_oh_20260517_174052; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_project_work_items_main_oh_20260517_174052 (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    project_volume numeric(18,3),
    unit character varying(50),
    source_reference text,
    comment text,
    created_at timestamp with time zone
);


--
-- Name: backup_reinf_stmt_20260813_194308_object_segments; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_reinf_stmt_20260813_194308_object_segments (
    id uuid,
    object_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text
);


--
-- Name: backup_reinf_stmt_20260813_194308_objects; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_reinf_stmt_20260813_194308_objects (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: backup_reinf_stmt_20260813_194308_pile_facts; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_reinf_stmt_20260813_194308_pile_facts (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text,
    segment_id uuid,
    pile_field_id uuid,
    seg_pk_start numeric(12,2),
    seg_pk_end numeric(12,2),
    seg_pk_raw_text text,
    volume_segment numeric(18,3),
    seg_review_tag text
);


--
-- Name: backup_reinf_stmt_20260813_194308_pile_fields; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_reinf_stmt_20260813_194308_pile_fields (
    id uuid,
    field_code character varying(100),
    field_type character varying(20),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    pile_type character varying(255),
    pile_count integer,
    dynamic_test_count integer,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    is_demo boolean,
    object_id uuid,
    catalog_status text,
    driven_pile_count integer,
    catalog_review_tag text
);


--
-- Name: backup_reinf_stmt_20260813_194308_pipe_pile_specs; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_reinf_stmt_20260813_194308_pipe_pile_specs (
    id uuid,
    object_id uuid,
    work_type_id uuid,
    pile_length_m numeric,
    quantity numeric,
    unit character varying,
    source_reference text,
    comment text,
    is_active boolean,
    created_at timestamp with time zone
);


--
-- Name: backup_reinf_stmt_20260813_194308_project_work_items; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_reinf_stmt_20260813_194308_project_work_items (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    project_volume numeric(18,3),
    unit character varying(50),
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    source_pile_field_id uuid
);


--
-- Name: backup_tikhomirov_pile_20260814_120343_object_segments; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_tikhomirov_pile_20260814_120343_object_segments (
    id uuid,
    object_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text
);


--
-- Name: backup_tikhomirov_pile_20260814_120343_objects; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_tikhomirov_pile_20260814_120343_objects (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: backup_tikhomirov_pile_20260814_120343_pile_plan_periods; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.backup_tikhomirov_pile_20260814_120343_pile_plan_periods (
    id uuid,
    section_id uuid,
    pile_field_id uuid,
    period_start date,
    period_end date,
    plan_type character varying(32),
    planned_main_piles integer,
    planned_test_piles integer,
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    planned_dynamic_tests integer,
    planned_headcaps integer
);


--
-- Name: bk_equipment_cumulative_add_20260814_created_identifiers; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_equipment_cumulative_add_20260814_created_identifiers (
    id uuid,
    equipment_unit_id uuid,
    identifier_type text,
    raw_value text,
    normalized_value text,
    created_at timestamp with time zone
);


--
-- Name: bk_equipment_cumulative_add_20260814_created_units; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_equipment_cumulative_add_20260814_created_units (
    id uuid,
    equipment_type text,
    brand_model text,
    unit_number text,
    plate_number text,
    ownership_type text,
    contractor_name text,
    status text,
    source_name text,
    source_date date,
    source_reference text,
    location text,
    vin text,
    drivers_count text,
    repair_reason text,
    stopped_at date,
    planned_work_at date,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    review_tag text
);


--
-- Name: bk_equipment_cumulative_add_20260814_groups; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_equipment_cumulative_add_20260814_groups (
    new_equipment_unit_id uuid,
    match_key text,
    match_key_type text,
    equipment_type text,
    brand_model text,
    unit_number text,
    plate_number text,
    vin text,
    status text,
    location text,
    source_reference text,
    source_date date,
    latest_source_row_number integer,
    source_rows bigint,
    type_count bigint,
    source_types text,
    source_brands text,
    first_metric_date date,
    last_metric_date date,
    mileage_km_total numeric,
    engine_hours_total numeric,
    fuel_liters_total numeric,
    created_at timestamp with time zone
);


--
-- Name: bk_equipment_cumulative_add_20260814_metric_rows; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_equipment_cumulative_add_20260814_metric_rows (
    id uuid,
    equipment_unit_id uuid,
    metric_date date,
    source_reference text,
    source_sheet text,
    source_row_number integer,
    source_location text,
    source_equipment_type text,
    source_brand_model text,
    source_plate_number text,
    source_unit_number text,
    source_vin text,
    source_status text,
    match_method text,
    matched_identifier_norm text,
    mileage_km numeric,
    engine_hours numeric,
    fuel_liters numeric,
    mileage_raw text,
    engine_hours_raw text,
    fuel_raw text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    candidate_match_key text,
    new_equipment_unit_id uuid
);


--
-- Name: bk_equipment_cumulative_vin_merge_20260814_identifiers; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_equipment_cumulative_vin_merge_20260814_identifiers (
    id uuid,
    equipment_unit_id uuid,
    identifier_type text,
    raw_value text,
    normalized_value text,
    created_at timestamp with time zone
);


--
-- Name: bk_equipment_cumulative_vin_merge_20260814_metrics; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_equipment_cumulative_vin_merge_20260814_metrics (
    id uuid,
    equipment_unit_id uuid,
    metric_date date,
    source_reference text,
    source_sheet text,
    source_row_number integer,
    source_location text,
    source_equipment_type text,
    source_brand_model text,
    source_plate_number text,
    source_unit_number text,
    source_vin text,
    source_status text,
    match_method text,
    matched_identifier_norm text,
    mileage_km numeric,
    engine_hours numeric,
    fuel_liters numeric,
    mileage_raw text,
    engine_hours_raw text,
    fuel_raw text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: bk_equipment_cumulative_vin_merge_20260814_pairs; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_equipment_cumulative_vin_merge_20260814_pairs (
    unit_norm text,
    loser_id uuid,
    survivor_id uuid,
    loser_type text,
    loser_brand_model text,
    loser_unit_number text,
    loser_plate_number text,
    loser_source_date date,
    survivor_type text,
    survivor_brand_model text,
    survivor_unit_number text,
    survivor_plate_number text,
    survivor_source_date date,
    created_at timestamp with time zone
);


--
-- Name: bk_equipment_cumulative_vin_merge_20260814_units; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_equipment_cumulative_vin_merge_20260814_units (
    id uuid,
    equipment_type text,
    brand_model text,
    unit_number text,
    plate_number text,
    ownership_type text,
    contractor_name text,
    status text,
    source_name text,
    source_date date,
    source_reference text,
    location text,
    vin text,
    drivers_count text,
    repair_reason text,
    stopped_at date,
    planned_work_at date,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    review_tag text
);


--
-- Name: bk_equipment_merge_20260814_identifiers; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_equipment_merge_20260814_identifiers (
    id uuid,
    equipment_unit_id uuid,
    identifier_type text,
    raw_value text,
    normalized_value text,
    created_at timestamp with time zone
);


--
-- Name: bk_equipment_merge_20260814_pairs; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_equipment_merge_20260814_pairs (
    loser_id uuid NOT NULL,
    survivor_id uuid NOT NULL,
    merge_key_type text NOT NULL,
    merge_key text NOT NULL,
    loser_label text,
    survivor_label text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: bk_equipment_merge_20260814_report_units; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_equipment_merge_20260814_report_units (
    id uuid,
    daily_report_id uuid,
    equipment_type character varying(100),
    brand_model character varying(255),
    unit_number character varying(100),
    plate_number character varying(100),
    ownership_type character varying(20),
    contractor_name character varying(255),
    status character varying(20),
    comment text,
    created_at timestamp with time zone,
    is_demo boolean,
    contractor_id uuid,
    review_tag text,
    equipment_unit_id uuid
);


--
-- Name: bk_equipment_merge_20260814_units; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_equipment_merge_20260814_units (
    id uuid,
    equipment_type text,
    brand_model text,
    unit_number text,
    plate_number text,
    ownership_type text,
    contractor_name text,
    status text,
    source_name text,
    source_date date,
    source_reference text,
    location text,
    vin text,
    drivers_count text,
    repair_reason text,
    stopped_at date,
    planned_work_at date,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    review_tag text
);


--
-- Name: bk_mm_pk3027_to_ad11_20260606_0535; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_mm_pk3027_to_ad11_20260606_0535 (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    material_id uuid,
    from_object_id uuid,
    to_object_id uuid,
    volume numeric(18,3),
    unit character varying(50),
    trip_count integer,
    movement_type character varying(50),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    equipment_type character varying(100),
    equipment_count integer,
    is_demo boolean,
    contractor_id uuid,
    review_tag text,
    haul_distance_km numeric,
    haul_distance_source text
);


--
-- Name: bk_mm_route_audit_clearfix_20260606_0549; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_mm_route_audit_clearfix_20260606_0549 (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    material_id uuid,
    from_object_id uuid,
    to_object_id uuid,
    volume numeric(18,3),
    unit character varying(50),
    trip_count integer,
    movement_type character varying(50),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    equipment_type character varying(100),
    equipment_count integer,
    is_demo boolean,
    contractor_id uuid,
    review_tag text,
    haul_distance_km numeric,
    haul_distance_source text
);


--
-- Name: bk_mm_route_unit_20260606_052146; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_mm_route_unit_20260606_052146 (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    material_id uuid,
    from_object_id uuid,
    to_object_id uuid,
    volume numeric(18,3),
    unit character varying(50),
    trip_count integer,
    movement_type character varying(50),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    equipment_type character varying(100),
    equipment_count integer,
    is_demo boolean,
    contractor_id uuid,
    review_tag text,
    haul_distance_km numeric,
    haul_distance_source text
);


--
-- Name: bk_mm_stockpile_material_relink2_20260606_0610; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_mm_stockpile_material_relink2_20260606_0610 (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    material_id uuid,
    from_object_id uuid,
    to_object_id uuid,
    volume numeric(18,3),
    unit character varying(50),
    trip_count integer,
    movement_type character varying(50),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    equipment_type character varying(100),
    equipment_count integer,
    is_demo boolean,
    contractor_id uuid,
    review_tag text,
    haul_distance_km numeric,
    haul_distance_source text
);


--
-- Name: bk_mm_stockpile_material_relink_20260606_0604; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_mm_stockpile_material_relink_20260606_0604 (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    material_id uuid,
    from_object_id uuid,
    to_object_id uuid,
    volume numeric(18,3),
    unit character varying(50),
    trip_count integer,
    movement_type character varying(50),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    equipment_type character varying(100),
    equipment_count integer,
    is_demo boolean,
    contractor_id uuid,
    review_tag text,
    haul_distance_km numeric,
    haul_distance_source text
);


--
-- Name: bk_object_segments_route_unit_20260606_052146; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_object_segments_route_unit_20260606_052146 (
    id uuid,
    object_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text
);


--
-- Name: bk_objects_route_unit_20260606_052146; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_objects_route_unit_20260606_052146 (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: bk_pile_s7_fix_20260528_085319_items; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_pile_s7_fix_20260528_085319_items (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: bk_pile_s7_fix_20260528_085319_meta; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_pile_s7_fix_20260528_085319_meta (
    backed_up_at timestamp with time zone,
    run_tag text,
    note text
);


--
-- Name: bk_pile_s7_fix_20260528_085319_reports; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_pile_s7_fix_20260528_085319_reports (
    id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    source_type character varying(50),
    source_reference text,
    raw_text text,
    parse_status character varying(30),
    operator_status character varying(30),
    created_at timestamp with time zone,
    status character varying(20),
    is_demo boolean,
    review_tag text,
    review_payload jsonb,
    initial_parse_payload jsonb,
    uploaded_by_username text
);


--
-- Name: bk_pile_s7_fix_20260528_085319_segments; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_pile_s7_fix_20260528_085319_segments (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: bk_pile_sched_20260528_082127_items; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_pile_sched_20260528_082127_items (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: bk_pile_sched_20260528_082127_meta; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_pile_sched_20260528_082127_meta (
    backup_created_at timestamp with time zone,
    run_tag text,
    old_item_count bigint,
    old_segment_count bigint,
    old_report_count bigint,
    stage_row_count bigint,
    stage_total_volume numeric
);


--
-- Name: bk_pile_sched_20260528_082127_reports; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_pile_sched_20260528_082127_reports (
    id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    source_type character varying(50),
    source_reference text,
    raw_text text,
    parse_status character varying(30),
    operator_status character varying(30),
    created_at timestamp with time zone,
    status character varying(20),
    is_demo boolean,
    review_tag text,
    review_payload jsonb,
    initial_parse_payload jsonb,
    uploaded_by_username text
);


--
-- Name: bk_pile_sched_20260528_082127_segments; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_pile_sched_20260528_082127_segments (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: bk_pile_sched_20260528_082127_stage; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_pile_sched_20260528_082127_stage (
    source_kind text,
    report_date text,
    work_code text,
    section_id text,
    section_code text,
    pile_field_id text,
    object_id text,
    field_code text,
    object_code text,
    pk_start numeric,
    pk_end numeric,
    pk_raw_text text,
    volume numeric,
    comment text,
    source_refs text,
    item_id uuid,
    report_id uuid
);


--
-- Name: bk_work_audit_ownerfix_dwi_20260606_060010; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_work_audit_ownerfix_dwi_20260606_060010 (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: bk_work_audit_ownerfix_mm_20260606_060010; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_work_audit_ownerfix_mm_20260606_060010 (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    material_id uuid,
    from_object_id uuid,
    to_object_id uuid,
    volume numeric(18,3),
    unit character varying(50),
    trip_count integer,
    movement_type character varying(50),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    equipment_type character varying(100),
    equipment_count integer,
    is_demo boolean,
    contractor_id uuid,
    review_tag text,
    haul_distance_km numeric,
    haul_distance_source text
);


--
-- Name: bk_work_audit_ownerfix_seg_20260606_060010; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_work_audit_ownerfix_seg_20260606_060010 (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: bk_work_audit_ownerfix_wieu_20260606_060010; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.bk_work_audit_ownerfix_wieu_20260606_060010 (
    id uuid,
    daily_work_item_id uuid,
    report_equipment_unit_id uuid,
    trips_count integer,
    worked_volume numeric(18,3),
    worked_area numeric(18,3),
    worked_length numeric(18,3),
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: daily_report_duplicate_candidates_20260818; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.daily_report_duplicate_candidates_20260818 (
    duplicate_group_no integer,
    duplicate_count integer,
    source_type_norm text,
    source_reference_norm text,
    payload_identity_hash text,
    report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    section_code character varying(50),
    status character varying(20),
    source_type character varying(50),
    source_reference text,
    created_at timestamp with time zone,
    review_payload_bytes integer,
    initial_parse_payload_bytes integer
);


--
-- Name: daily_work_item_segment_mismatch_20260818; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.daily_work_item_segment_mismatch_20260818 (
    daily_work_item_id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_code character varying(50),
    object_code character varying(100),
    object_name character varying(255),
    work_type_code character varying(100),
    work_type_name character varying(255),
    item_volume numeric(18,3),
    segment_count integer,
    segment_volume numeric,
    delta_volume numeric
);


--
-- Name: daily_work_items_duplicate_candidates_20260818; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.daily_work_items_duplicate_candidates_20260818 (
    duplicate_group_no integer,
    duplicate_count integer,
    daily_work_item_id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_code character varying(50),
    object_id uuid,
    object_code character varying(100),
    object_name character varying(255),
    work_type_code character varying(100),
    work_type_name character varying(255),
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    created_at timestamp with time zone
);


--
-- Name: equipment_identifier_chain_cleanup_20260825; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_identifier_chain_cleanup_20260825 (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    entity text NOT NULL,
    action text NOT NULL,
    entity_id uuid,
    payload jsonb NOT NULL
);


--
-- Name: equipment_identifier_chain_cleanup_20260825_id_seq; Type: SEQUENCE; Schema: audit_backup; Owner: -
--

CREATE SEQUENCE audit_backup.equipment_identifier_chain_cleanup_20260825_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipment_identifier_chain_cleanup_20260825_id_seq; Type: SEQUENCE OWNED BY; Schema: audit_backup; Owner: -
--

ALTER SEQUENCE audit_backup.equipment_identifier_chain_cleanup_20260825_id_seq OWNED BY audit_backup.equipment_identifier_chain_cleanup_20260825.id;


--
-- Name: equipment_master_dedupe_20260827; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_master_dedupe_20260827 (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cleanup_tag text NOT NULL,
    entity text NOT NULL,
    action text NOT NULL,
    entity_id uuid,
    payload jsonb NOT NULL
);


--
-- Name: equipment_master_dedupe_20260827_id_seq; Type: SEQUENCE; Schema: audit_backup; Owner: -
--

CREATE SEQUENCE audit_backup.equipment_master_dedupe_20260827_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipment_master_dedupe_20260827_id_seq; Type: SEQUENCE OWNED BY; Schema: audit_backup; Owner: -
--

ALTER SEQUENCE audit_backup.equipment_master_dedupe_20260827_id_seq OWNED BY audit_backup.equipment_master_dedupe_20260827.id;


--
-- Name: equipment_master_restore_plates_20260827_094100; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_master_restore_plates_20260827_094100 (
    id uuid,
    equipment_type text,
    brand_model text,
    unit_number text,
    plate_number text,
    ownership_type text,
    contractor_name text,
    status text,
    source_name text,
    source_date date,
    source_reference text,
    location text,
    vin text,
    drivers_count text,
    repair_reason text,
    stopped_at date,
    planned_work_at date,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    review_tag text,
    restored_plate_number text,
    evidence_rows numeric,
    last_seen date,
    backup_created_at timestamp with time zone,
    restore_reason text
);


--
-- Name: equipment_operation_metrics_kburg_dedup_backup_20260817; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_operation_metrics_kburg_dedup_backup_20260817 (
    id uuid,
    equipment_unit_id uuid,
    metric_date date,
    source_reference text,
    source_sheet text,
    source_row_number integer,
    source_location text,
    source_equipment_type text,
    source_brand_model text,
    source_plate_number text,
    source_unit_number text,
    source_vin text,
    source_status text,
    match_method text,
    matched_identifier_norm text,
    mileage_km numeric,
    engine_hours numeric,
    fuel_liters numeric,
    mileage_raw text,
    engine_hours_raw text,
    fuel_raw text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    movement_hours numeric,
    refuel_liters numeric,
    drain_liters numeric,
    received_liters numeric,
    issued_liters numeric,
    dispenser_liters numeric,
    source_responsible text,
    source_constructive text,
    backup_created_at timestamp with time zone
);


--
-- Name: equipment_operation_metrics_split_506_723_backup_20260825; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_operation_metrics_split_506_723_backup_20260825 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    equipment_unit_id uuid,
    metric_date date NOT NULL,
    source_reference text NOT NULL,
    source_sheet text DEFAULT 'Лист1'::text NOT NULL,
    source_row_number integer NOT NULL,
    source_location text,
    source_equipment_type text,
    source_brand_model text,
    source_plate_number text,
    source_unit_number text,
    source_vin text,
    source_status text,
    match_method text,
    matched_identifier_norm text,
    mileage_km numeric,
    engine_hours numeric,
    fuel_liters numeric,
    mileage_raw text,
    engine_hours_raw text,
    fuel_raw text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    movement_hours numeric,
    refuel_liters numeric,
    drain_liters numeric,
    received_liters numeric,
    issued_liters numeric,
    dispenser_liters numeric,
    source_responsible text,
    source_constructive text
);


--
-- Name: equipment_plate_in_unit_reu_20260827; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_plate_in_unit_reu_20260827 (
    backup_created_at timestamp with time zone,
    id uuid,
    daily_report_id uuid,
    equipment_type character varying(100),
    brand_model character varying(255),
    unit_number character varying(100),
    plate_number character varying(100),
    ownership_type character varying(20),
    contractor_name character varying(255),
    status character varying(20),
    comment text,
    created_at timestamp with time zone,
    is_demo boolean,
    contractor_id uuid,
    review_tag text,
    equipment_unit_id uuid,
    report_date date,
    source_reference text,
    section_code character varying,
    unit_norm text
);


--
-- Name: equipment_plate_in_unit_review_payload_20260827; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_plate_in_unit_review_payload_20260827 (
    backup_created_at timestamp with time zone DEFAULT now() NOT NULL,
    daily_report_id uuid NOT NULL,
    report_date date,
    source_reference text,
    old_review_payload jsonb NOT NULL,
    new_review_payload jsonb NOT NULL,
    changed_equipment_rows integer NOT NULL
);


--
-- Name: equipment_unit_identifiers_dedup_backup_20260817; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_unit_identifiers_dedup_backup_20260817 (
    id uuid,
    equipment_unit_id uuid,
    identifier_type text,
    raw_value text,
    normalized_value text,
    created_at timestamp with time zone
);


--
-- Name: equipment_unit_identifiers_inactive_unit_backup_20260818; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_unit_identifiers_inactive_unit_backup_20260818 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    equipment_unit_id uuid NOT NULL,
    identifier_type text NOT NULL,
    raw_value text NOT NULL,
    normalized_value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT equipment_unit_identifiers_identifier_type_check CHECK ((identifier_type = ANY (ARRAY['unit'::text, 'plate'::text])))
);


--
-- Name: equipment_unit_identifiers_kburg_dedup_backup_20260817; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_unit_identifiers_kburg_dedup_backup_20260817 (
    id uuid,
    equipment_unit_id uuid,
    identifier_type text,
    raw_value text,
    normalized_value text,
    created_at timestamp with time zone,
    backup_created_at timestamp with time zone
);


--
-- Name: equipment_unit_identifiers_plate_equals_vin_backup_20260818; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_unit_identifiers_plate_equals_vin_backup_20260818 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    equipment_unit_id uuid NOT NULL,
    identifier_type text NOT NULL,
    raw_value text NOT NULL,
    normalized_value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT equipment_unit_identifiers_identifier_type_check CHECK ((identifier_type = ANY (ARRAY['unit'::text, 'plate'::text])))
);


--
-- Name: equipment_unit_identifiers_split_506_723_backup_20260825; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_unit_identifiers_split_506_723_backup_20260825 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    equipment_unit_id uuid NOT NULL,
    identifier_type text NOT NULL,
    raw_value text NOT NULL,
    normalized_value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT equipment_unit_identifiers_identifier_type_check CHECK ((identifier_type = ANY (ARRAY['unit'::text, 'plate'::text])))
);


--
-- Name: equipment_unit_link_dedup_backup_20260817; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_unit_link_dedup_backup_20260817 (
    table_name text NOT NULL,
    row_id uuid NOT NULL,
    previous_equipment_unit_id uuid,
    backup_created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: equipment_units_dedup_backup_20260817; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_units_dedup_backup_20260817 (
    id uuid,
    equipment_type text,
    brand_model text,
    unit_number text,
    plate_number text,
    ownership_type text,
    contractor_name text,
    status text,
    source_name text,
    source_date date,
    source_reference text,
    location text,
    vin text,
    drivers_count text,
    repair_reason text,
    stopped_at date,
    planned_work_at date,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    review_tag text
);


--
-- Name: equipment_units_kburg_dedup_backup_20260817; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_units_kburg_dedup_backup_20260817 (
    id uuid,
    equipment_type text,
    brand_model text,
    unit_number text,
    plate_number text,
    ownership_type text,
    contractor_name text,
    status text,
    source_name text,
    source_date date,
    source_reference text,
    location text,
    vin text,
    drivers_count text,
    repair_reason text,
    stopped_at date,
    planned_work_at date,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    review_tag text,
    backup_created_at timestamp with time zone
);


--
-- Name: equipment_units_plate_equals_vin_backup_20260818; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_units_plate_equals_vin_backup_20260818 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    equipment_type text NOT NULL,
    brand_model text,
    unit_number text,
    plate_number text,
    ownership_type text DEFAULT 'unknown'::text NOT NULL,
    contractor_name text,
    status text DEFAULT 'unknown'::text NOT NULL,
    source_name text,
    source_date date,
    source_reference text,
    location text,
    vin text,
    drivers_count text,
    repair_reason text,
    stopped_at date,
    planned_work_at date,
    comment text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    review_tag text,
    CONSTRAINT equipment_units_ownership_type_check CHECK ((ownership_type = ANY (ARRAY['own'::text, 'hired'::text, 'unknown'::text]))),
    CONSTRAINT equipment_units_status_check CHECK ((status = ANY (ARRAY['working'::text, 'repair'::text, 'out'::text, 'standby'::text, 'unknown'::text])))
);


--
-- Name: equipment_units_split_506_723_backup_20260825; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.equipment_units_split_506_723_backup_20260825 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    equipment_type text NOT NULL,
    brand_model text,
    unit_number text,
    plate_number text,
    ownership_type text DEFAULT 'unknown'::text NOT NULL,
    contractor_name text,
    status text DEFAULT 'unknown'::text NOT NULL,
    source_name text,
    source_date date,
    source_reference text,
    location text,
    vin text,
    drivers_count text,
    repair_reason text,
    stopped_at date,
    planned_work_at date,
    comment text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    review_tag text,
    CONSTRAINT equipment_units_ownership_type_check CHECK ((ownership_type = ANY (ARRAY['own'::text, 'hired'::text, 'unknown'::text]))),
    CONSTRAINT equipment_units_status_check CHECK ((status = ANY (ARRAY['working'::text, 'repair'::text, 'out'::text, 'standby'::text, 'unknown'::text])))
);


--
-- Name: inactive_object_fact_refs_20260818; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.inactive_object_fact_refs_20260818 (
    source_table text,
    object_role text,
    fact_id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_code character varying(50),
    object_id uuid,
    object_code character varying(100),
    object_name character varying(255),
    work_type_code character varying,
    work_type_name character varying,
    material_code text,
    movement_type text,
    volume numeric(18,3),
    unit character varying(50),
    comment text
);


--
-- Name: material_movements_duplicate_candidates_20260818; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.material_movements_duplicate_candidates_20260818 (
    duplicate_group_no integer,
    duplicate_count integer,
    material_movement_id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_code character varying(50),
    material_id uuid,
    material_code character varying(50),
    material_name character varying(255),
    from_object_id uuid,
    from_object_code character varying(100),
    from_object_name character varying(255),
    to_object_id uuid,
    to_object_code character varying(100),
    to_object_name character varying(255),
    unit character varying(50),
    volume numeric(18,3),
    trip_count integer,
    movement_type character varying(50),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    created_at timestamp with time zone
);


--
-- Name: material_movements_duplicate_cleanup_backup_20260728; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.material_movements_duplicate_cleanup_backup_20260728 (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    material_id uuid,
    from_object_id uuid,
    to_object_id uuid,
    volume numeric(18,3),
    unit character varying(50),
    trip_count integer,
    movement_type character varying(50),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    equipment_type character varying(100),
    equipment_count integer,
    is_demo boolean,
    contractor_id uuid,
    review_tag text,
    haul_distance_km numeric,
    haul_distance_source text
);


--
-- Name: object_aliases_duplicate_cleanup_backup_20260728; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.object_aliases_duplicate_cleanup_backup_20260728 (
    id uuid,
    canonical_code text,
    alias_text text,
    kind text,
    notes text,
    created_at timestamp with time zone
);


--
-- Name: object_segments_duplicate_cleanup_backup_20260728; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.object_segments_duplicate_cleanup_backup_20260728 (
    id uuid,
    object_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text
);


--
-- Name: object_type_work_type_defaults_backup_20260521; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.object_type_work_type_defaults_backup_20260521 (
    mapping_key text,
    source_group text,
    object_type_id uuid,
    object_code_pattern text,
    applicability_note text,
    work_type_id uuid,
    display_work_name text,
    display_unit character varying(50),
    sort_order integer,
    is_active boolean,
    zero_volume_hint boolean,
    review_tag text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: objects_duplicate_cleanup_backup_20260728; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.objects_duplicate_cleanup_backup_20260728 (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: objects_duplicate_cleanup_ref_counts_20260728; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.objects_duplicate_cleanup_ref_counts_20260728 (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    target_code text,
    constructives bigint,
    daily_work_items bigint,
    material_movements_from bigint,
    material_movements_to bigint,
    planned_work_items bigint,
    project_work_items bigint,
    pile_fields bigint,
    stockpiles bigint,
    temporary_roads bigint,
    rd_rows bigint,
    rd_documents bigint,
    object_segments bigint,
    aliases bigint
);


--
-- Name: pile_plan_periods_sep2026_before_20260903_142124; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.pile_plan_periods_sep2026_before_20260903_142124 (
    id uuid,
    section_id uuid,
    pile_field_id uuid,
    period_start date,
    period_end date,
    plan_type character varying(32),
    planned_main_piles integer,
    planned_test_piles integer,
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    planned_dynamic_tests integer,
    planned_headcaps integer
);


--
-- Name: planned_work_items_dyntest_total_backup_20260818; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.planned_work_items_dyntest_total_backup_20260818 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    constructive_id uuid,
    work_type_id uuid NOT NULL,
    source_project_work_item_id uuid,
    source_pile_field_id uuid,
    source_pile_plan_period_id uuid,
    source_reference text,
    unit character varying(50) DEFAULT 'шт'::character varying NOT NULL,
    planned_volume numeric(18,3) DEFAULT 0 NOT NULL,
    period_start date,
    period_end date,
    plan_type character varying(30) DEFAULT 'total'::character varying NOT NULL,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT planned_work_items_period_check CHECK ((((period_start IS NULL) AND (period_end IS NULL)) OR ((period_start IS NOT NULL) AND (period_end IS NOT NULL) AND (period_end >= period_start)))),
    CONSTRAINT planned_work_items_pk_check CHECK (((pk_start IS NULL) OR (pk_end IS NULL) OR (pk_end >= pk_start))),
    CONSTRAINT planned_work_items_volume_nonnegative CHECK ((planned_volume >= (0)::numeric))
);


--
-- Name: planned_work_items_pile_total_mirrors_backup_20260818; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.planned_work_items_pile_total_mirrors_backup_20260818 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    constructive_id uuid,
    work_type_id uuid NOT NULL,
    source_project_work_item_id uuid,
    source_pile_field_id uuid,
    source_pile_plan_period_id uuid,
    source_reference text,
    unit character varying(50) DEFAULT 'шт'::character varying NOT NULL,
    planned_volume numeric(18,3) DEFAULT 0 NOT NULL,
    period_start date,
    period_end date,
    plan_type character varying(30) DEFAULT 'total'::character varying NOT NULL,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT planned_work_items_period_check CHECK ((((period_start IS NULL) AND (period_end IS NULL)) OR ((period_start IS NOT NULL) AND (period_end IS NOT NULL) AND (period_end >= period_start)))),
    CONSTRAINT planned_work_items_pk_check CHECK (((pk_start IS NULL) OR (pk_end IS NULL) OR (pk_end >= pk_start))),
    CONSTRAINT planned_work_items_volume_nonnegative CHECK ((planned_volume >= (0)::numeric))
);


--
-- Name: planned_work_items_pipe_trial_sep2026_before_20260903_144820; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.planned_work_items_pipe_trial_sep2026_before_20260903_144820 (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    source_project_work_item_id uuid,
    source_pile_field_id uuid,
    source_pile_plan_period_id uuid,
    source_reference text,
    unit character varying(50),
    planned_volume numeric(18,3),
    period_start date,
    period_end date,
    plan_type character varying(30),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: planned_work_items_sep2026_before_20260903_142124; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.planned_work_items_sep2026_before_20260903_142124 (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    source_project_work_item_id uuid,
    source_pile_field_id uuid,
    source_pile_plan_period_id uuid,
    source_reference text,
    unit character varying(50),
    planned_volume numeric(18,3),
    period_start date,
    period_end date,
    plan_type character varying(30),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: project_work_item_segment_mismatch_20260818; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.project_work_item_segment_mismatch_20260818 (
    project_work_item_id uuid,
    object_code character varying(100),
    object_name character varying(255),
    work_type_code character varying(100),
    work_type_name character varying(255),
    source_reference text,
    item_volume numeric(18,3),
    segment_count integer,
    segment_volume numeric,
    delta_volume numeric
);


--
-- Name: report_equipment_units_kburg_dedup_backup_20260817; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.report_equipment_units_kburg_dedup_backup_20260817 (
    id uuid,
    daily_report_id uuid,
    equipment_type character varying(100),
    brand_model character varying(255),
    unit_number character varying(100),
    plate_number character varying(100),
    ownership_type character varying(20),
    contractor_name character varying(255),
    status character varying(20),
    comment text,
    created_at timestamp with time zone,
    is_demo boolean,
    contractor_id uuid,
    review_tag text,
    equipment_unit_id uuid,
    backup_created_at timestamp with time zone
);


--
-- Name: report_equipment_units_split_506_723_backup_20260825; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.report_equipment_units_split_506_723_backup_20260825 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    daily_report_id uuid NOT NULL,
    equipment_type character varying(100) NOT NULL,
    brand_model character varying(255),
    unit_number character varying(100),
    plate_number character varying(100),
    ownership_type character varying(20) DEFAULT 'unknown'::character varying NOT NULL,
    contractor_name character varying(255),
    status character varying(20) DEFAULT 'unknown'::character varying NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    contractor_id uuid,
    review_tag text,
    equipment_unit_id uuid,
    CONSTRAINT report_equipment_units_ownership_type_check CHECK (((ownership_type)::text = ANY ((ARRAY['own'::character varying, 'hired'::character varying, 'unknown'::character varying])::text[]))),
    CONSTRAINT report_equipment_units_status_check CHECK (((status)::text = ANY ((ARRAY['working'::character varying, 'repair'::character varying, 'out'::character varying, 'standby'::character varying, 'unknown'::character varying])::text[])))
);


--
-- Name: stockpile_report_uch8_20260817_night_backup_20260819; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.stockpile_report_uch8_20260817_night_backup_20260819 (
    source_table text,
    row_data jsonb
);


--
-- Name: work_type_aliases_bad_material_canonical_backup_20260824; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.work_type_aliases_bad_material_canonical_backup_20260824 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    canonical_code text NOT NULL,
    alias_text text NOT NULL,
    kind text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: work_type_aliases_bad_material_wrapped_backup_20260824; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.work_type_aliases_bad_material_wrapped_backup_20260824 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    canonical_code text NOT NULL,
    alias_text text NOT NULL,
    kind text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: work_type_aliases_before_all_reports_alias_learning_20260824_10; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.work_type_aliases_before_all_reports_alias_learning_20260824_10 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    canonical_code text NOT NULL,
    alias_text text NOT NULL,
    kind text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: work_type_aliases_material_conflict_backup_20260824; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.work_type_aliases_material_conflict_backup_20260824 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    canonical_code text NOT NULL,
    alias_text text NOT NULL,
    kind text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: work_type_aliases_normalized_duplicate_backup_20260818; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.work_type_aliases_normalized_duplicate_backup_20260818 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    canonical_code text NOT NULL,
    alias_text text NOT NULL,
    kind text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: work_type_aliases_removed_20260909; Type: TABLE; Schema: audit_backup; Owner: -
--

CREATE TABLE audit_backup.work_type_aliases_removed_20260909 (
    id uuid,
    canonical_code text,
    alias_text text,
    kind text,
    notes text,
    created_at timestamp with time zone,
    removal_reason text,
    backed_up_at timestamp with time zone
);


--
-- Name: daily_report_problems; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.daily_report_problems (
    id uuid,
    daily_report_id uuid,
    problem_text text,
    sort_order integer,
    created_at timestamp with time zone
);


--
-- Name: daily_report_staff_counts; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.daily_report_staff_counts (
    id uuid,
    daily_report_id uuid,
    category text,
    count integer,
    created_at timestamp with time zone
);


--
-- Name: daily_reports; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.daily_reports (
    id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    source_type character varying(50),
    source_reference text,
    raw_text text,
    parse_status character varying(30),
    operator_status character varying(30),
    created_at timestamp with time zone,
    status character varying(20),
    is_demo boolean,
    review_tag text,
    review_payload jsonb,
    initial_parse_payload jsonb
);


--
-- Name: daily_work_item_segments; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.daily_work_item_segments (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: daily_work_items; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.daily_work_items (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: material_movement_equipment_usage; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.material_movement_equipment_usage (
    id uuid,
    material_movement_id uuid,
    report_equipment_unit_id uuid,
    trips_count integer,
    worked_volume numeric(18,3),
    comment text,
    created_at timestamp with time zone,
    is_demo boolean,
    review_tag text
);


--
-- Name: material_movements; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.material_movements (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    material_id uuid,
    from_object_id uuid,
    to_object_id uuid,
    volume numeric(18,3),
    unit character varying(50),
    trip_count integer,
    movement_type character varying(50),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    equipment_type character varying(100),
    equipment_count integer,
    is_demo boolean,
    contractor_id uuid,
    review_tag text
);


--
-- Name: materials; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.materials (
    id uuid,
    code character varying(50),
    name character varying(255),
    default_unit character varying(50),
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: object_segments; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.object_segments (
    id uuid,
    object_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text
);


--
-- Name: object_types; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.object_types (
    id uuid,
    code character varying(50),
    name character varying(255),
    created_at timestamp with time zone,
    sort_order integer,
    is_active boolean,
    map_enabled boolean,
    work_accounting_enabled boolean,
    material_accounting_enabled boolean,
    is_linear boolean,
    accounting_note text,
    review_tag text
);


--
-- Name: objects; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.objects (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: parser_learning_cases; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.parser_learning_cases (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift text,
    section_code text,
    source_reference text,
    case_type text,
    item_path text,
    raw_fragment text,
    initial_value jsonb,
    final_value jsonb,
    status text,
    fingerprint text,
    created_at timestamp with time zone
);


--
-- Name: report_equipment_units; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.report_equipment_units (
    id uuid,
    daily_report_id uuid,
    equipment_type character varying(100),
    brand_model character varying(255),
    unit_number character varying(100),
    plate_number character varying(100),
    ownership_type character varying(20),
    contractor_name character varying(255),
    status character varying(20),
    comment text,
    created_at timestamp with time zone,
    is_demo boolean,
    contractor_id uuid,
    review_tag text,
    equipment_unit_id uuid
);


--
-- Name: stockpile_balance_snapshots; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.stockpile_balance_snapshots (
    id uuid,
    stockpile_id uuid,
    snapshot_date date,
    balance_volume numeric(18,3),
    unit character varying(50),
    comment text,
    created_at timestamp with time zone,
    is_demo boolean,
    review_tag text
);


--
-- Name: stockpiles; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.stockpiles (
    id uuid,
    object_id uuid,
    material_id uuid,
    name character varying(255),
    is_active boolean,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: target_reports; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.target_reports (
    id uuid,
    source_reference text,
    report_date date,
    shift character varying(20),
    section_code character varying(50),
    created_at timestamp with time zone
);


--
-- Name: temporary_road_status_segments; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.temporary_road_status_segments (
    id uuid,
    road_id uuid,
    status_date date,
    status_type text,
    input_pk_system text,
    road_pk_start numeric,
    road_pk_end numeric,
    rail_pk_start numeric,
    rail_pk_end numeric,
    import_run_id uuid,
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    is_demo boolean,
    review_tag text,
    object_id uuid
);


--
-- Name: work_item_equipment_usage; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.work_item_equipment_usage (
    id uuid,
    daily_work_item_id uuid,
    report_equipment_unit_id uuid,
    trips_count integer,
    worked_volume numeric(18,3),
    worked_area numeric(18,3),
    worked_length numeric(18,3),
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: work_types; Type: TABLE; Schema: backup_yuri_max_cleanup_20260520t204635z; Owner: -
--

CREATE TABLE backup_yuri_max_cleanup_20260520t204635z.work_types (
    id uuid,
    code character varying(100),
    name character varying(255),
    default_unit character varying(50),
    work_group character varying(100),
    is_active boolean,
    created_at timestamp with time zone,
    show_in_timeline boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: reinf_imp_20260827_120812_obj_before; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.reinf_imp_20260827_120812_obj_before (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: reinf_imp_20260827_120812_pf_before; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.reinf_imp_20260827_120812_pf_before (
    id uuid,
    field_code character varying(100),
    field_type character varying(20),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    pile_type character varying(255),
    pile_count integer,
    dynamic_test_count integer,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    is_demo boolean,
    object_id uuid,
    catalog_status text,
    driven_pile_count integer,
    catalog_review_tag text
);


--
-- Name: reinf_imp_20260827_120812_pps_before; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.reinf_imp_20260827_120812_pps_before (
    id uuid,
    object_id uuid,
    work_type_id uuid,
    pile_length_m numeric,
    quantity numeric,
    unit character varying,
    source_reference text,
    comment text,
    is_active boolean,
    created_at timestamp with time zone
);


--
-- Name: reinf_imp_20260827_120812_pwi_before; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.reinf_imp_20260827_120812_pwi_before (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    project_volume numeric(18,3),
    unit character varying(50),
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    source_pile_field_id uuid
);


--
-- Name: reinf_imp_20260827_120812_seg_before; Type: TABLE; Schema: maintenance; Owner: -
--

CREATE TABLE maintenance.reinf_imp_20260827_120812_seg_before (
    id uuid,
    object_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text
);


--
-- Name: analytics_work_category_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_work_category_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category_code text NOT NULL,
    source_kind text NOT NULL,
    source_code text NOT NULL,
    included boolean DEFAULT true NOT NULL,
    comment text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text
);


--
-- Name: backup_isso_pk3245_ms11_20260824_124002_attrs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_isso_pk3245_ms11_20260824_124002_attrs (
    backup_at timestamp with time zone,
    id uuid,
    object_id uuid,
    snapshot_id uuid,
    source_row integer,
    source_no text,
    source_scope text,
    source_name text,
    span_scheme_text text,
    length_m numeric,
    supports_total integer,
    source_pk_m numeric,
    match_method text,
    raw_payload jsonb,
    created_at timestamp with time zone
);


--
-- Name: backup_isso_pk3245_ms11_20260824_124002_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_isso_pk3245_ms11_20260824_124002_lines (
    backup_at timestamp with time zone,
    id uuid,
    snapshot_id uuid,
    object_id uuid,
    object_attribute_id uuid,
    source_row integer,
    required_sequence_text text,
    executor_text text,
    transferred_supports_text text,
    rd_status text,
    rd_available_text text,
    remark text,
    raw_payload jsonb,
    created_at timestamp with time zone
);


--
-- Name: construction_section_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.construction_section_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    section_id uuid NOT NULL,
    valid_from date NOT NULL,
    valid_to date,
    pk_start numeric(12,2) NOT NULL,
    pk_end numeric(12,2) NOT NULL,
    pk_raw_text text,
    is_current boolean DEFAULT true NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    boundary_kind text DEFAULT 'main'::text NOT NULL,
    CONSTRAINT construction_section_versions_check CHECK ((pk_end >= pk_start))
);


--
-- Name: construction_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.construction_sections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(255) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    map_color character varying(7),
    sort_order integer
);


--
-- Name: constructive_work_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.constructive_work_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    constructive_id uuid NOT NULL,
    work_type_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: constructives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.constructives (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(255) NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    object_type_id uuid,
    object_id uuid,
    comment text
);


--
-- Name: contractors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contractors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    short_name character varying(100),
    inn character varying(20),
    kind character varying(30) DEFAULT 'subcontractor'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_report_parse_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_report_parse_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    daily_report_id uuid NOT NULL,
    candidate_type character varying(50) NOT NULL,
    payload_json jsonb NOT NULL,
    confidence numeric(5,2),
    needs_manual_review boolean DEFAULT true NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_report_problems; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_report_problems (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    daily_report_id uuid NOT NULL,
    problem_text text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_report_quality_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_report_quality_metrics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    daily_report_id uuid,
    daily_report_id_text text NOT NULL,
    metric_kind text DEFAULT 'uploaded_to_day3'::text NOT NULL,
    source_type text,
    source_reference text,
    report_date date,
    shift text,
    uploaded_by_username text,
    is_pile_shift_report boolean DEFAULT false NOT NULL,
    uploaded_snapshot_id uuid,
    day3_snapshot_id uuid,
    snapshot_pair_hash text NOT NULL,
    comparable_units integer DEFAULT 0 NOT NULL,
    changed_units integer DEFAULT 0 NOT NULL,
    changed_percent numeric(6,2) DEFAULT 0 NOT NULL,
    added_rows integer DEFAULT 0 NOT NULL,
    removed_rows integer DEFAULT 0 NOT NULL,
    changed_rows integer DEFAULT 0 NOT NULL,
    changed_fields integer DEFAULT 0 NOT NULL,
    section_breakdown jsonb DEFAULT '{}'::jsonb NOT NULL,
    calculated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_report_quality_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_report_quality_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    daily_report_id uuid,
    daily_report_id_text text NOT NULL,
    snapshot_kind text NOT NULL,
    snapshot_payload jsonb NOT NULL,
    payload_hash text NOT NULL,
    report_date date,
    shift text,
    source_type text,
    source_reference text,
    uploaded_by_username text,
    review_flags jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_pile_shift_report boolean DEFAULT false NOT NULL,
    snapshot_at timestamp with time zone NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    captured_by text,
    capture_status text DEFAULT 'captured'::text NOT NULL,
    CONSTRAINT daily_report_quality_snapshots_snapshot_kind_check CHECK ((snapshot_kind = ANY (ARRAY['uploaded'::text, 'day3'::text])))
);


--
-- Name: daily_report_review_payload_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_report_review_payload_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    daily_report_id uuid,
    daily_report_id_text text NOT NULL,
    version_no integer NOT NULL,
    reason text DEFAULT 'unspecified'::text NOT NULL,
    status text,
    review_payload jsonb,
    initial_parse_payload jsonb,
    payload_hash text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_report_staff_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_report_staff_counts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    daily_report_id uuid NOT NULL,
    category text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_date date NOT NULL,
    shift character varying(20) NOT NULL,
    section_id uuid,
    source_type character varying(50) NOT NULL,
    source_reference text,
    raw_text text,
    parse_status character varying(30) DEFAULT 'new'::character varying NOT NULL,
    operator_status character varying(30) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying,
    is_demo boolean DEFAULT false NOT NULL,
    review_tag text,
    review_payload jsonb,
    initial_parse_payload jsonb,
    uploaded_by_username text,
    user_flags jsonb DEFAULT '[]'::jsonb,
    CONSTRAINT daily_reports_operator_status_check CHECK (((operator_status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT daily_reports_parse_status_check CHECK (((parse_status)::text = ANY ((ARRAY['new'::character varying, 'parsed'::character varying, 'needs_review'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT daily_reports_shift_check CHECK (((shift)::text = ANY ((ARRAY['day'::character varying, 'night'::character varying, 'unknown'::character varying])::text[])))
);


--
-- Name: daily_section_rating_mstroy_convergence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_section_rating_mstroy_convergence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rating_date date NOT NULL,
    scope text NOT NULL,
    section_code text NOT NULL,
    difference_percent numeric(7,2) NOT NULL,
    score numeric(6,2) NOT NULL,
    comment text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT daily_section_rating_mstroy_convergenc_difference_percent_check CHECK (((difference_percent >= (0)::numeric) AND (difference_percent <= (1000)::numeric))),
    CONSTRAINT daily_section_rating_mstroy_convergence_scope_check CHECK ((scope = ANY (ARRAY['zp'::text, 'isso'::text]))),
    CONSTRAINT daily_section_rating_mstroy_convergence_score_check CHECK (((score >= (0)::numeric) AND (score <= (100)::numeric)))
);


--
-- Name: daily_work_item_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_work_item_segments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    daily_work_item_id uuid NOT NULL,
    pk_start numeric(12,2) NOT NULL,
    pk_end numeric(12,2) NOT NULL,
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    volume_segment numeric(18,3),
    is_demo boolean DEFAULT false NOT NULL,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text,
    CONSTRAINT daily_work_item_segments_check CHECK ((pk_end >= pk_start))
);


--
-- Name: daily_work_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_work_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    daily_report_id uuid NOT NULL,
    report_date date NOT NULL,
    shift character varying(20) NOT NULL,
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid NOT NULL,
    work_name_raw text,
    unit character varying(50) NOT NULL,
    volume numeric(18,3) NOT NULL,
    labor_source_type character varying(20) DEFAULT 'unknown'::character varying NOT NULL,
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    productivity_enabled boolean DEFAULT true NOT NULL,
    review_tag text,
    analytics_tag text,
    CONSTRAINT daily_work_items_labor_source_type_check CHECK (((labor_source_type)::text = ANY ((ARRAY['own'::character varying, 'hired'::character varying, 'mixed'::character varying, 'unknown'::character varying])::text[]))),
    CONSTRAINT daily_work_items_shift_check CHECK (((shift)::text = ANY ((ARRAY['day'::character varying, 'night'::character varying, 'unknown'::character varying])::text[])))
);


--
-- Name: dashboard_people_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_people_rows (
    id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    row_type text NOT NULL,
    card_code text,
    card_label text,
    card_type text,
    region_code text,
    region_label text,
    section_code text,
    "position" text,
    department_path text,
    source_row integer,
    depth integer DEFAULT 0 NOT NULL,
    hired_count integer DEFAULT 0 NOT NULL,
    at_work_count integer DEFAULT 0 NOT NULL,
    intershift_count integer DEFAULT 0 NOT NULL,
    vacation_count integer DEFAULT 0 NOT NULL,
    sick_count integer DEFAULT 0 NOT NULL,
    day_off_count integer DEFAULT 0 NOT NULL,
    absence_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dashboard_people_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_people_snapshots (
    id uuid NOT NULL,
    report_date date NOT NULL,
    source_filename text,
    source_path text,
    sheet_name text NOT NULL,
    hired_count integer DEFAULT 0 NOT NULL,
    at_work_count integer DEFAULT 0 NOT NULL,
    intershift_count integer DEFAULT 0 NOT NULL,
    vacation_count integer DEFAULT 0 NOT NULL,
    sick_count integer DEFAULT 0 NOT NULL,
    day_off_count integer DEFAULT 0 NOT NULL,
    absence_count integer DEFAULT 0 NOT NULL,
    imported_by text,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    raw_payload jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: dashboard_response_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_response_cache (
    endpoint text NOT NULL,
    cache_key text NOT NULL,
    fingerprint text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dashboard_response_cache_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_response_cache_state (
    cache_scope text NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dashboard_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_settings (
    key text NOT NULL,
    payload jsonb NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: db_change_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.db_change_audit (
    id bigint NOT NULL,
    table_name text NOT NULL,
    action text NOT NULL,
    pk_json jsonb,
    before_json jsonb,
    after_json jsonb,
    changed_by text DEFAULT 'dashboard'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: db_change_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.db_change_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: db_change_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.db_change_audit_id_seq OWNED BY public.db_change_audit.id;


--
-- Name: equipment_conflict_cleanup_identifiers_backup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_conflict_cleanup_identifiers_backup (
    cleanup_tag text NOT NULL,
    backed_up_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid NOT NULL,
    row_data jsonb NOT NULL
);


--
-- Name: equipment_conflict_cleanup_metrics_backup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_conflict_cleanup_metrics_backup (
    cleanup_tag text NOT NULL,
    backed_up_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid NOT NULL,
    row_data jsonb NOT NULL
);


--
-- Name: equipment_conflict_cleanup_report_units_backup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_conflict_cleanup_report_units_backup (
    cleanup_tag text NOT NULL,
    backed_up_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid NOT NULL,
    row_data jsonb NOT NULL
);


--
-- Name: equipment_conflict_cleanup_units_backup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_conflict_cleanup_units_backup (
    cleanup_tag text NOT NULL,
    backed_up_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid NOT NULL,
    row_data jsonb NOT NULL
);


--
-- Name: equipment_norms_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_norms_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category text NOT NULL,
    key jsonb NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text
);


--
-- Name: equipment_operation_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_operation_metrics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    equipment_unit_id uuid,
    metric_date date NOT NULL,
    source_reference text NOT NULL,
    source_sheet text DEFAULT 'Лист1'::text NOT NULL,
    source_row_number integer NOT NULL,
    source_location text,
    source_equipment_type text,
    source_brand_model text,
    source_plate_number text,
    source_unit_number text,
    source_vin text,
    source_status text,
    match_method text,
    matched_identifier_norm text,
    mileage_km numeric,
    engine_hours numeric,
    fuel_liters numeric,
    mileage_raw text,
    engine_hours_raw text,
    fuel_raw text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    movement_hours numeric,
    refuel_liters numeric,
    drain_liters numeric,
    received_liters numeric,
    issued_liters numeric,
    dispenser_liters numeric,
    source_responsible text,
    source_constructive text
);


--
-- Name: equipment_operation_metrics_by_unit; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.equipment_operation_metrics_by_unit AS
 SELECT equipment_unit_id,
    min(metric_date) AS first_metric_date,
    max(metric_date) AS last_metric_date,
    (count(*))::integer AS source_rows,
    (count(*) FILTER (WHERE (mileage_km IS NOT NULL)))::integer AS mileage_rows,
    (count(*) FILTER (WHERE (engine_hours IS NOT NULL)))::integer AS engine_hours_rows,
    (count(*) FILTER (WHERE (fuel_liters IS NOT NULL)))::integer AS fuel_rows,
    sum(COALESCE(mileage_km, (0)::numeric)) AS mileage_km_total,
    sum(COALESCE(engine_hours, (0)::numeric)) AS engine_hours_total,
    sum(COALESCE(fuel_liters, (0)::numeric)) AS fuel_liters_total
   FROM public.equipment_operation_metrics
  WHERE (equipment_unit_id IS NOT NULL)
  GROUP BY equipment_unit_id;


--
-- Name: equipment_productivity_norms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_productivity_norms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    equipment_type character varying(50) NOT NULL,
    metric character varying(50) NOT NULL,
    value numeric(10,2) NOT NULL,
    unit character varying(20) DEFAULT 'м3'::character varying NOT NULL,
    note text,
    effective_from date DEFAULT '2024-01-01'::date NOT NULL,
    effective_to date,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: equipment_unit_identifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_unit_identifiers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    equipment_unit_id uuid NOT NULL,
    identifier_type text NOT NULL,
    raw_value text NOT NULL,
    normalized_value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT equipment_unit_identifiers_identifier_type_check CHECK ((identifier_type = ANY (ARRAY['unit'::text, 'plate'::text])))
);


--
-- Name: equipment_unit_identifiers_6939_split_backup_20260820; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_unit_identifiers_6939_split_backup_20260820 (
    id uuid,
    equipment_unit_id uuid,
    identifier_type text,
    raw_value text,
    normalized_value text,
    created_at timestamp with time zone
);


--
-- Name: equipment_unit_link_6939_split_backup_20260820; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_unit_link_6939_split_backup_20260820 (
    table_name text NOT NULL,
    row_id uuid NOT NULL,
    previous_equipment_unit_id uuid,
    backup_created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: equipment_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_units (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    equipment_type text NOT NULL,
    brand_model text,
    unit_number text,
    plate_number text,
    ownership_type text DEFAULT 'unknown'::text NOT NULL,
    contractor_name text,
    status text DEFAULT 'unknown'::text NOT NULL,
    source_name text,
    source_date date,
    source_reference text,
    location text,
    vin text,
    drivers_count text,
    repair_reason text,
    stopped_at date,
    planned_work_at date,
    comment text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    review_tag text,
    CONSTRAINT equipment_units_ownership_type_check CHECK ((ownership_type = ANY (ARRAY['own'::text, 'hired'::text, 'unknown'::text]))),
    CONSTRAINT equipment_units_status_check CHECK ((status = ANY (ARRAY['working'::text, 'repair'::text, 'out'::text, 'standby'::text, 'unknown'::text])))
);


--
-- Name: equipment_units_6939_split_backup_20260820; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_units_6939_split_backup_20260820 (
    id uuid,
    equipment_type text,
    brand_model text,
    unit_number text,
    plate_number text,
    ownership_type text,
    contractor_name text,
    status text,
    source_name text,
    source_date date,
    source_reference text,
    location text,
    vin text,
    drivers_count text,
    repair_reason text,
    stopped_at date,
    planned_work_at date,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    review_tag text
);


--
-- Name: isso_front_transfer_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.isso_front_transfer_lines (
    id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    object_id uuid NOT NULL,
    object_attribute_id uuid,
    source_row integer,
    required_sequence_text text,
    executor_text text,
    transferred_supports_text text,
    rd_status text,
    rd_available_text text,
    remark text,
    raw_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: isso_front_transfer_monthly_plan; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.isso_front_transfer_monthly_plan (
    id uuid NOT NULL,
    line_id uuid NOT NULL,
    plan_month date NOT NULL,
    month_label text,
    support_range_text text NOT NULL,
    raw_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: isso_front_transfer_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.isso_front_transfer_snapshots (
    id uuid NOT NULL,
    snapshot_date date NOT NULL,
    source_filename text,
    source_reference text NOT NULL,
    source_sha256 text,
    title text,
    review_status text DEFAULT 'imported'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text,
    comment text
);


--
-- Name: isso_object_front_attributes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.isso_object_front_attributes (
    id uuid NOT NULL,
    object_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    source_row integer,
    source_no text,
    source_scope text,
    source_name text,
    span_scheme_text text,
    length_m numeric,
    supports_total integer,
    source_pk_m numeric,
    match_method text,
    raw_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mainline_fill_state_corrections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mainline_fill_state_corrections (
    id uuid NOT NULL,
    section_id uuid NOT NULL,
    effective_date date NOT NULL,
    action text DEFAULT 'set_status'::text NOT NULL,
    status_type text NOT NULL,
    pk_start numeric NOT NULL,
    pk_end numeric NOT NULL,
    comment text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mainline_fill_state_corrections_action_check CHECK ((action = ANY (ARRAY['set_status'::text, 'clear_status'::text]))),
    CONSTRAINT mainline_fill_state_corrections_check CHECK ((pk_start <= pk_end)),
    CONSTRAINT mainline_fill_state_corrections_status_type_check CHECK ((status_type = ANY (ARRAY['prep_works'::text, 'main_works'::text, 'protective_layer_2'::text, 'protective_layer_1'::text, 'asphalt_layer'::text, 'no_work'::text])))
);


--
-- Name: mainline_fill_status_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mainline_fill_status_segments (
    id uuid NOT NULL,
    daily_report_id uuid,
    section_id uuid NOT NULL,
    status_date date NOT NULL,
    status_type text NOT NULL,
    pk_start numeric NOT NULL,
    pk_end numeric NOT NULL,
    source_reference text,
    comment text,
    is_demo boolean DEFAULT false NOT NULL,
    review_tag text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mainline_fill_status_segments_check CHECK ((pk_start <= pk_end)),
    CONSTRAINT mainline_fill_status_segments_status_type_check CHECK ((status_type = ANY (ARRAY['prep_works'::text, 'main_works'::text, 'protective_layer_2'::text, 'protective_layer_1'::text, 'asphalt_layer'::text])))
);


--
-- Name: mainline_rd_coverage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mainline_rd_coverage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    section_id uuid,
    object_id uuid,
    object_type_code text,
    pk_start numeric NOT NULL,
    pk_end numeric NOT NULL,
    rd_code text,
    rd_title text,
    issued_at date,
    comment text,
    is_active boolean DEFAULT true NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mainline_rd_coverage_check CHECK ((pk_start <= pk_end))
);


--
-- Name: mainline_work_schedule_ranges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mainline_work_schedule_ranges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    section_id uuid,
    object_id uuid,
    object_type_code text,
    pk_start numeric NOT NULL,
    pk_end numeric NOT NULL,
    required_start_date date,
    required_finish_date date,
    schedule_label text,
    comment text,
    is_active boolean DEFAULT true NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mainline_work_schedule_ranges_check CHECK ((pk_start <= pk_end))
);


--
-- Name: material_movement_equipment_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_movement_equipment_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    material_movement_id uuid NOT NULL,
    report_equipment_unit_id uuid NOT NULL,
    trips_count integer,
    worked_volume numeric(18,3),
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    review_tag text,
    work_hours numeric(5,2),
    CONSTRAINT material_movement_equipment_usage_work_hours_check CHECK (((work_hours IS NULL) OR ((work_hours > (0)::numeric) AND (work_hours <= (11)::numeric))))
);


--
-- Name: material_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    daily_report_id uuid NOT NULL,
    report_date date NOT NULL,
    shift character varying(20) NOT NULL,
    section_id uuid,
    material_id uuid NOT NULL,
    from_object_id uuid NOT NULL,
    to_object_id uuid NOT NULL,
    volume numeric(18,3) NOT NULL,
    unit character varying(50) NOT NULL,
    trip_count integer,
    movement_type character varying(50) NOT NULL,
    labor_source_type character varying(20) DEFAULT 'unknown'::character varying NOT NULL,
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    equipment_type character varying(100),
    equipment_count integer DEFAULT 1,
    is_demo boolean DEFAULT false NOT NULL,
    contractor_id uuid,
    review_tag text,
    haul_distance_km numeric,
    haul_distance_source text,
    CONSTRAINT material_movements_labor_source_type_check CHECK (((labor_source_type)::text = ANY ((ARRAY['own'::character varying, 'hired'::character varying, 'mixed'::character varying, 'unknown'::character varying])::text[]))),
    CONSTRAINT material_movements_movement_type_check CHECK (((movement_type)::text = ANY ((ARRAY['pit_to_constructive'::character varying, 'pit_to_stockpile'::character varying, 'stockpile_to_constructive'::character varying, 'stockpile_to_stockpile'::character varying, 'constructive_to_stockpile'::character varying, 'constructive_to_constructive'::character varying])::text[]))),
    CONSTRAINT material_movements_shift_check CHECK (((shift)::text = ANY ((ARRAY['day'::character varying, 'night'::character varying, 'unknown'::character varying])::text[])))
);


--
-- Name: materials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.materials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(255) NOT NULL,
    default_unit character varying(50) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    review_tag text
);


--
-- Name: object_map_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.object_map_points (
    object_id uuid NOT NULL,
    latitude double precision,
    longitude double precision,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    CONSTRAINT object_map_points_lat_check CHECK (((latitude IS NULL) OR ((latitude >= ('-90'::integer)::double precision) AND (latitude <= (90)::double precision)))),
    CONSTRAINT object_map_points_lng_check CHECK (((longitude IS NULL) OR ((longitude >= ('-180'::integer)::double precision) AND (longitude <= (180)::double precision)))),
    CONSTRAINT object_map_points_pair_check CHECK ((((latitude IS NULL) AND (longitude IS NULL)) OR ((latitude IS NOT NULL) AND (longitude IS NOT NULL))))
);


--
-- Name: object_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.object_segments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    pk_start numeric(12,2) NOT NULL,
    pk_end numeric(12,2) NOT NULL,
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text,
    CONSTRAINT object_segments_check CHECK ((pk_end >= pk_start))
);


--
-- Name: object_type_work_type_defaults; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.object_type_work_type_defaults (
    mapping_key text NOT NULL,
    source_group text NOT NULL,
    object_type_id uuid,
    object_code_pattern text,
    applicability_note text,
    work_type_id uuid,
    display_work_name text NOT NULL,
    display_unit character varying(50),
    sort_order integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    zero_volume_hint boolean DEFAULT true NOT NULL,
    review_tag text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE object_type_work_type_defaults; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.object_type_work_type_defaults IS 'Owner-approved default work hints for object types/groups in DiM-style reports. Rows are hints for filling project/fact volumes; zero volumes are still shown.';


--
-- Name: COLUMN object_type_work_type_defaults.object_code_pattern; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.object_type_work_type_defaults.object_code_pattern IS 'Optional SQL LIKE-style pattern or human pattern that narrows a work set inside an object type, e.g. PFT_%.';


--
-- Name: COLUMN object_type_work_type_defaults.zero_volume_hint; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.object_type_work_type_defaults.zero_volume_hint IS 'If true, show this work as a fill hint even when project/fact volume is zero or missing.';


--
-- Name: object_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.object_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    map_enabled boolean DEFAULT true NOT NULL,
    work_accounting_enabled boolean DEFAULT true NOT NULL,
    material_accounting_enabled boolean DEFAULT false NOT NULL,
    is_linear boolean DEFAULT false NOT NULL,
    accounting_note text,
    review_tag text
);


--
-- Name: objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_code character varying(100) NOT NULL,
    name character varying(255) NOT NULL,
    object_type_id uuid NOT NULL,
    constructive_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    review_tag text
);


--
-- Name: parser_learning_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parser_learning_cases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    daily_report_id uuid,
    report_date date,
    shift text,
    section_code text,
    source_reference text,
    case_type text NOT NULL,
    item_path text NOT NULL,
    raw_fragment text,
    initial_value jsonb,
    final_value jsonb,
    status text DEFAULT 'new'::text NOT NULL,
    fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT parser_learning_cases_status_check CHECK ((status = ANY (ARRAY['new'::text, 'reviewed'::text, 'implemented'::text, 'ignored'::text])))
);


--
-- Name: personnel_accommodation_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personnel_accommodation_rows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    snapshot_id uuid NOT NULL,
    group_kind text NOT NULL,
    facility_type text NOT NULL,
    settlement text,
    camp_name text,
    section_label text,
    facility_name text NOT NULL,
    address text,
    places_total numeric,
    places_base numeric,
    places_actual numeric,
    residents numeric,
    free_places numeric,
    itr_places_total numeric,
    itr_places_occupied numeric,
    canteen_people numeric,
    canteen_seats_plan numeric,
    canteen_seats_fact numeric,
    note text,
    sort_order integer DEFAULT 0 NOT NULL,
    raw_row jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personnel_accommodation_rows_facility_type_check CHECK ((facility_type = ANY (ARRAY['hotel'::text, 'apartment'::text, 'dorm'::text, 'canteen'::text]))),
    CONSTRAINT personnel_accommodation_rows_group_kind_check CHECK ((group_kind = ANY (ARRAY['hotels_apartments'::text, 'dorms_canteens'::text])))
);


--
-- Name: personnel_accommodation_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personnel_accommodation_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_date date NOT NULL,
    source_filename text,
    source_reference text,
    sheet_name text,
    imported_by text,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    row_count integer DEFAULT 0 NOT NULL,
    raw_payload jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: pile_delivery_calendar; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pile_delivery_calendar (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    delivery_date date NOT NULL,
    supplier_name text NOT NULL,
    supplier_code text,
    raw_spec_text text NOT NULL,
    spec_code text,
    planned_qty numeric DEFAULT 0 NOT NULL,
    actual_qty numeric DEFAULT 0 NOT NULL,
    source_reference text DEFAULT ''::text NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    exclude_from_totals boolean DEFAULT false NOT NULL,
    CONSTRAINT pile_delivery_calendar_actual_qty_check CHECK ((actual_qty >= (0)::numeric)),
    CONSTRAINT pile_delivery_calendar_planned_qty_check CHECK ((planned_qty >= (0)::numeric))
);


--
-- Name: pile_delivery_specs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pile_delivery_specs (
    spec_code text NOT NULL,
    display_name text NOT NULL,
    length_m integer,
    placement_side text,
    comment text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pile_delivery_specs_length_m_check CHECK (((length_m IS NULL) OR (length_m > 0))),
    CONSTRAINT pile_delivery_specs_placement_side_check CHECK (((placement_side IS NULL) OR (placement_side = ANY (ARRAY['ns'::text, 'vs'::text]))))
);


--
-- Name: pile_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pile_fields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    field_code character varying(100) NOT NULL,
    field_type character varying(20) NOT NULL,
    pk_start numeric(12,2) NOT NULL,
    pk_end numeric(12,2) NOT NULL,
    pk_raw_text text,
    pile_type character varying(255) NOT NULL,
    pile_count integer NOT NULL,
    dynamic_test_count integer,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    is_demo boolean DEFAULT false NOT NULL,
    object_id uuid,
    catalog_status text,
    driven_pile_count integer,
    catalog_review_tag text,
    CONSTRAINT pile_fields_dynamic_tests_check CHECK (((dynamic_test_count IS NULL) OR (dynamic_test_count >= 0))),
    CONSTRAINT pile_fields_field_type_check CHECK (((field_type)::text = ANY ((ARRAY['main'::character varying, 'test'::character varying])::text[]))),
    CONSTRAINT pile_fields_pile_count_check CHECK ((pile_count >= 0)),
    CONSTRAINT pile_fields_pk_range_check CHECK ((pk_end >= pk_start))
);


--
-- Name: pile_plan_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pile_plan_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    section_id uuid,
    pile_field_id uuid,
    period_start date NOT NULL,
    period_end date NOT NULL,
    plan_type character varying(32) DEFAULT 'monthly'::character varying NOT NULL,
    planned_main_piles integer DEFAULT 0 NOT NULL,
    planned_test_piles integer DEFAULT 0 NOT NULL,
    source_reference text,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    planned_dynamic_tests integer DEFAULT 0 NOT NULL,
    planned_headcaps integer DEFAULT 0 NOT NULL,
    CONSTRAINT pile_plan_periods_check CHECK ((period_end >= period_start)),
    CONSTRAINT pile_plan_periods_check1 CHECK (((section_id IS NOT NULL) OR (pile_field_id IS NOT NULL))),
    CONSTRAINT pile_plan_periods_dynamic_nonnegative CHECK ((planned_dynamic_tests >= 0)),
    CONSTRAINT pile_plan_periods_headcaps_nonnegative CHECK ((planned_headcaps >= 0)),
    CONSTRAINT pile_plan_periods_planned_main_piles_check CHECK ((planned_main_piles >= 0)),
    CONSTRAINT pile_plan_periods_planned_test_piles_check CHECK ((planned_test_piles >= 0))
);


--
-- Name: pipe_pile_specs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pipe_pile_specs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    work_type_id uuid NOT NULL,
    pile_length_m numeric NOT NULL,
    quantity numeric NOT NULL,
    unit character varying DEFAULT 'шт'::character varying NOT NULL,
    source_reference text DEFAULT ''::text NOT NULL,
    comment text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pipe_pile_specs_pile_length_m_check CHECK ((pile_length_m > (0)::numeric)),
    CONSTRAINT pipe_pile_specs_quantity_check CHECK ((quantity >= (0)::numeric))
);


--
-- Name: planned_work_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planned_work_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    constructive_id uuid,
    work_type_id uuid NOT NULL,
    source_project_work_item_id uuid,
    source_pile_field_id uuid,
    source_pile_plan_period_id uuid,
    source_reference text,
    unit character varying(50) DEFAULT 'шт'::character varying NOT NULL,
    planned_volume numeric(18,3) DEFAULT 0 NOT NULL,
    period_start date,
    period_end date,
    plan_type character varying(30) DEFAULT 'total'::character varying NOT NULL,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_section_id uuid,
    CONSTRAINT planned_work_items_period_check CHECK ((((period_start IS NULL) AND (period_end IS NULL)) OR ((period_start IS NOT NULL) AND (period_end IS NOT NULL) AND (period_end >= period_start)))),
    CONSTRAINT planned_work_items_pk_check CHECK (((pk_start IS NULL) OR (pk_end IS NULL) OR (pk_end >= pk_start))),
    CONSTRAINT planned_work_items_volume_nonnegative CHECK ((planned_volume >= (0)::numeric))
);


--
-- Name: COLUMN planned_work_items.assigned_section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.planned_work_items.assigned_section_id IS 'Operational construction section selected for this plan in Statements; may differ from the object geography.';


--
-- Name: project_work_item_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_work_item_segments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_work_item_id uuid NOT NULL,
    pk_start numeric(12,2) NOT NULL,
    pk_end numeric(12,2) NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pk_raw_text text,
    volume_segment numeric,
    CONSTRAINT project_work_item_segments_check CHECK ((pk_end >= pk_start))
);


--
-- Name: project_work_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_work_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    constructive_id uuid,
    work_type_id uuid NOT NULL,
    project_volume numeric(18,3) NOT NULL,
    unit character varying(50) NOT NULL,
    source_reference text,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_pile_field_id uuid
);


--
-- Name: rd_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rd_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    filename text NOT NULL,
    storage_path text NOT NULL,
    sha256 text NOT NULL,
    mime_type text,
    file_size bigint DEFAULT 0 NOT NULL,
    document_type text DEFAULT 'vor'::text NOT NULL,
    document_date date,
    source_number text,
    default_object_id uuid,
    default_object_type_code text,
    status text DEFAULT 'uploaded'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    parse_error text,
    uploaded_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: rd_publication_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rd_publication_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rd_document_id uuid NOT NULL,
    rd_row_id uuid,
    project_work_item_id uuid,
    project_segment_id uuid,
    published_volume numeric DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: rd_row_manual_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rd_row_manual_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rd_row_id uuid NOT NULL,
    kind text NOT NULL,
    target_id uuid,
    canonical_code text,
    alias_text text,
    notes text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: rd_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rd_rows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rd_document_id uuid NOT NULL,
    row_index integer NOT NULL,
    raw_name text,
    unit text,
    volume numeric,
    pk_start numeric,
    pk_end numeric,
    pk_raw text,
    page_number integer,
    table_index integer,
    row_number integer,
    bbox jsonb,
    raw_cells jsonb DEFAULT '[]'::jsonb NOT NULL,
    object_id uuid,
    work_type_id uuid,
    material_id uuid,
    item_kind text DEFAULT 'work'::text NOT NULL,
    match_status text DEFAULT 'unresolved'::text NOT NULL,
    confidence numeric DEFAULT 0 NOT NULL,
    candidates jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reference_dedup_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reference_dedup_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    source_code text,
    source_id uuid,
    source_label text,
    target_code text,
    target_id uuid,
    target_label text,
    operation text NOT NULL,
    counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text
);


--
-- Name: report_equipment_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_equipment_units (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    daily_report_id uuid NOT NULL,
    equipment_type character varying(100) NOT NULL,
    brand_model character varying(255),
    unit_number character varying(100),
    plate_number character varying(100),
    ownership_type character varying(20) DEFAULT 'unknown'::character varying NOT NULL,
    contractor_name character varying(255),
    status character varying(20) DEFAULT 'unknown'::character varying NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    contractor_id uuid,
    review_tag text,
    equipment_unit_id uuid,
    CONSTRAINT report_equipment_units_ownership_type_check CHECK (((ownership_type)::text = ANY ((ARRAY['own'::character varying, 'hired'::character varying, 'unknown'::character varying])::text[]))),
    CONSTRAINT report_equipment_units_status_check CHECK (((status)::text = ANY ((ARRAY['working'::character varying, 'repair'::character varying, 'out'::character varying, 'standby'::character varying, 'unknown'::character varying])::text[])))
);


--
-- Name: route_pickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.route_pickets (
    id integer NOT NULL,
    pk_number integer NOT NULL,
    pk_name character varying(20) NOT NULL,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE route_pickets; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.route_pickets IS 'Ось трассы ВСМ: координаты пикетных точек для карты. 657 точек ПК2641-ПК3325';


--
-- Name: route_pickets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.route_pickets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: route_pickets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.route_pickets_id_seq OWNED BY public.route_pickets.id;


--
-- Name: section_quarry_haul_distances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.section_quarry_haul_distances (
    section_code text NOT NULL,
    quarry_object_id uuid NOT NULL,
    distance_km numeric,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text
);


--
-- Name: statement_customer_closed_work_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statement_customer_closed_work_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    section_code text NOT NULL,
    object_id uuid,
    work_type_id uuid,
    unit text,
    closed_volume numeric DEFAULT 0 NOT NULL,
    closed_amount numeric,
    unit_rate numeric,
    pk_start numeric,
    pk_end numeric,
    pk_raw_text text,
    source_kind text,
    source_file text NOT NULL,
    source_file_sha256 text NOT NULL,
    source_sheet text NOT NULL,
    source_row integer NOT NULL,
    source_estimate_code text,
    source_estimate_name text,
    source_group_name text,
    source_work_name text,
    match_status text DEFAULT 'REVIEW'::text NOT NULL,
    match_score numeric,
    match_note text,
    candidate_notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text
);


--
-- Name: statement_object_unit_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statement_object_unit_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    work_type_id uuid NOT NULL,
    region_code text NOT NULL,
    region_label text NOT NULL,
    rate numeric,
    currency text DEFAULT 'RUB'::text NOT NULL,
    unit text,
    pile_length_m numeric,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    CONSTRAINT statement_object_unit_rates_region_check CHECK ((region_code = ANY (ARRAY['novgorod'::text, 'tver'::text])))
);


--
-- Name: stockpile_balance_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stockpile_balance_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    stockpile_id uuid NOT NULL,
    snapshot_date date NOT NULL,
    balance_volume numeric(18,3) NOT NULL,
    unit character varying(50) NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    review_tag text
);


--
-- Name: stockpiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stockpiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    material_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    review_tag text
);


--
-- Name: temp_road_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temp_road_points (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    road_id uuid,
    road_code text,
    seq_no integer NOT NULL,
    pk_label text,
    x_msk numeric,
    y_msk numeric,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: temporary_road_import_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporary_road_import_drafts (
    id uuid NOT NULL,
    kind text NOT NULL,
    report_date date NOT NULL,
    source_file text,
    status text DEFAULT 'draft'::text NOT NULL,
    parsed_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    warnings_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    errors_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    preview_md text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    committed_at timestamp with time zone,
    import_run_id uuid,
    CONSTRAINT temporary_road_import_drafts_kind_check CHECK ((kind = ANY (ARRAY['daily'::text, 'correction'::text]))),
    CONSTRAINT temporary_road_import_drafts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'committed'::text, 'rejected'::text, 'error'::text])))
);


--
-- Name: temporary_road_import_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporary_road_import_runs (
    id uuid NOT NULL,
    source_type text NOT NULL,
    source_reference text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    rows_total integer,
    rows_loaded integer,
    rows_failed integer,
    message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT temporary_road_import_runs_rows_failed_check CHECK (((rows_failed IS NULL) OR (rows_failed >= 0))),
    CONSTRAINT temporary_road_import_runs_rows_loaded_check CHECK (((rows_loaded IS NULL) OR (rows_loaded >= 0))),
    CONSTRAINT temporary_road_import_runs_rows_total_check CHECK (((rows_total IS NULL) OR (rows_total >= 0))),
    CONSTRAINT temporary_road_import_runs_source_type_check CHECK ((source_type = ANY (ARRAY['manual'::text, 'xlsx'::text, 'yandex_table'::text, 'script'::text]))),
    CONSTRAINT temporary_road_import_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'partial'::text, 'failed'::text])))
);


--
-- Name: temporary_road_pk_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporary_road_pk_mappings (
    id uuid NOT NULL,
    road_id uuid NOT NULL,
    mapping_type text DEFAULT 'full_axis_range'::text NOT NULL,
    ad_pk_start numeric NOT NULL,
    ad_pk_end numeric NOT NULL,
    rail_pk_start numeric NOT NULL,
    rail_pk_end numeric NOT NULL,
    source_reference text,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT temporary_road_pk_mappings_ad_range_check CHECK ((ad_pk_end >= ad_pk_start)),
    CONSTRAINT temporary_road_pk_mappings_mapping_type_check CHECK ((mapping_type = ANY (ARRAY['full_axis_range'::text, 'segment_range'::text, 'manual'::text]))),
    CONSTRAINT temporary_road_pk_mappings_rail_range_check CHECK ((rail_pk_end >= rail_pk_start))
);


--
-- Name: temporary_road_state_corrections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporary_road_state_corrections (
    id uuid NOT NULL,
    road_id uuid NOT NULL,
    effective_date date NOT NULL,
    action text NOT NULL,
    status_type text,
    input_pk_system text NOT NULL,
    road_pk_start numeric,
    road_pk_end numeric,
    rail_pk_start numeric,
    rail_pk_end numeric,
    section_override text,
    source_draft_id uuid,
    source_reference text,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT temporary_road_state_corrections_action_check CHECK ((action = ANY (ARRAY['set_status'::text, 'clear_status'::text]))),
    CONSTRAINT temporary_road_state_corrections_check CHECK ((((road_pk_start IS NOT NULL) AND (road_pk_end IS NOT NULL)) OR ((rail_pk_start IS NOT NULL) AND (rail_pk_end IS NOT NULL)))),
    CONSTRAINT temporary_road_state_corrections_check1 CHECK (((road_pk_start IS NULL) OR (road_pk_end >= road_pk_start))),
    CONSTRAINT temporary_road_state_corrections_check2 CHECK (((rail_pk_start IS NULL) OR (rail_pk_end >= rail_pk_start))),
    CONSTRAINT temporary_road_state_corrections_input_pk_system_check CHECK ((input_pk_system = ANY (ARRAY['road'::text, 'rail'::text, 'both'::text]))),
    CONSTRAINT temporary_road_state_corrections_status_type_check CHECK ((status_type = ANY (ARRAY['pioneer_fill'::text, 'subgrade_not_to_grade'::text, 'dso'::text, 'ready_for_shpgs'::text, 'shpgs_done'::text, 'no_work'::text])))
);


--
-- Name: temporary_road_status_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporary_road_status_segments (
    id uuid NOT NULL,
    road_id uuid NOT NULL,
    status_date date NOT NULL,
    status_type text NOT NULL,
    input_pk_system text NOT NULL,
    road_pk_start numeric,
    road_pk_end numeric,
    rail_pk_start numeric,
    rail_pk_end numeric,
    import_run_id uuid,
    source_reference text,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    review_tag text,
    object_id uuid,
    daily_report_id uuid,
    CONSTRAINT temporary_road_status_segments_input_pk_system_check CHECK ((input_pk_system = ANY (ARRAY['road'::text, 'rail'::text, 'both'::text]))),
    CONSTRAINT temporary_road_status_segments_input_pk_system_consistency_chec CHECK ((((input_pk_system = 'road'::text) AND (road_pk_start IS NOT NULL) AND (road_pk_end IS NOT NULL)) OR ((input_pk_system = 'rail'::text) AND (rail_pk_start IS NOT NULL) AND (rail_pk_end IS NOT NULL)) OR ((input_pk_system = 'both'::text) AND (road_pk_start IS NOT NULL) AND (road_pk_end IS NOT NULL) AND (rail_pk_start IS NOT NULL) AND (rail_pk_end IS NOT NULL)))),
    CONSTRAINT temporary_road_status_segments_presence_check CHECK ((((road_pk_start IS NOT NULL) AND (road_pk_end IS NOT NULL)) OR ((rail_pk_start IS NOT NULL) AND (rail_pk_end IS NOT NULL)))),
    CONSTRAINT temporary_road_status_segments_rail_pair_check CHECK ((((rail_pk_start IS NULL) AND (rail_pk_end IS NULL)) OR ((rail_pk_start IS NOT NULL) AND (rail_pk_end IS NOT NULL)))),
    CONSTRAINT temporary_road_status_segments_rail_range_check CHECK (((rail_pk_start IS NULL) OR (rail_pk_end >= rail_pk_start))),
    CONSTRAINT temporary_road_status_segments_road_pair_check CHECK ((((road_pk_start IS NULL) AND (road_pk_end IS NULL)) OR ((road_pk_start IS NOT NULL) AND (road_pk_end IS NOT NULL)))),
    CONSTRAINT temporary_road_status_segments_road_range_check CHECK (((road_pk_start IS NULL) OR (road_pk_end >= road_pk_start))),
    CONSTRAINT temporary_road_status_segments_status_type_check CHECK ((status_type = ANY (ARRAY['pioneer_fill'::text, 'subgrade_not_to_grade'::text, 'dso'::text, 'ready_for_shpgs'::text, 'shpgs_done'::text])))
);


--
-- Name: temporary_roads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporary_roads (
    id uuid NOT NULL,
    road_code text NOT NULL,
    road_name text NOT NULL,
    section_id uuid,
    road_type text,
    ad_start_pk numeric,
    ad_end_pk numeric,
    rail_start_pk numeric,
    rail_end_pk numeric,
    can_translate_to_rail boolean DEFAULT false NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    object_id uuid,
    display_in_dashboard boolean DEFAULT true NOT NULL,
    CONSTRAINT temporary_roads_ad_pair_check CHECK ((((ad_start_pk IS NULL) AND (ad_end_pk IS NULL)) OR ((ad_start_pk IS NOT NULL) AND (ad_end_pk IS NOT NULL)))),
    CONSTRAINT temporary_roads_ad_range_check CHECK (((ad_start_pk IS NULL) OR (ad_end_pk >= ad_start_pk))),
    CONSTRAINT temporary_roads_rail_pair_check CHECK ((((rail_start_pk IS NULL) AND (rail_end_pk IS NULL)) OR ((rail_start_pk IS NOT NULL) AND (rail_end_pk IS NOT NULL)))),
    CONSTRAINT temporary_roads_rail_range_check CHECK (((rail_start_pk IS NULL) OR (rail_end_pk >= rail_start_pk))),
    CONSTRAINT temporary_roads_road_code_nonempty CHECK ((btrim(road_code) <> ''::text)),
    CONSTRAINT temporary_roads_road_name_nonempty CHECK ((btrim(road_name) <> ''::text)),
    CONSTRAINT temporary_roads_road_type_check CHECK (((road_type IS NULL) OR (road_type = ANY (ARRAY['temporary_access'::text, 'haul_road'::text, 'service_road'::text, 'other'::text])))),
    CONSTRAINT temporary_roads_translate_flag_check CHECK (((can_translate_to_rail = false) OR ((ad_start_pk IS NOT NULL) AND (ad_end_pk IS NOT NULL) AND (rail_start_pk IS NOT NULL) AND (rail_end_pk IS NOT NULL))))
);


--
-- Name: work_analytics_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_analytics_tags (
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: work_item_equipment_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_item_equipment_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    daily_work_item_id uuid NOT NULL,
    report_equipment_unit_id uuid NOT NULL,
    trips_count integer,
    worked_volume numeric(18,3),
    worked_area numeric(18,3),
    worked_length numeric(18,3),
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    review_tag text,
    work_hours numeric(5,2),
    CONSTRAINT work_item_equipment_usage_work_hours_check CHECK (((work_hours IS NULL) OR ((work_hours > (0)::numeric) AND (work_hours <= (11)::numeric))))
);


--
-- Name: work_type_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_type_aliases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    canonical_code text NOT NULL,
    alias_text text NOT NULL,
    kind text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: work_type_unit_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_type_unit_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    work_type_id uuid NOT NULL,
    region_code text NOT NULL,
    region_label text NOT NULL,
    rate numeric,
    currency text DEFAULT 'RUB'::text NOT NULL,
    unit text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    pile_length_m numeric,
    CONSTRAINT work_type_unit_rates_region_check CHECK ((region_code = ANY (ARRAY['novgorod'::text, 'tver'::text])))
);


--
-- Name: work_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(100) NOT NULL,
    name character varying(255) NOT NULL,
    default_unit character varying(50) NOT NULL,
    work_group character varying(100),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    show_in_timeline boolean DEFAULT false NOT NULL,
    productivity_enabled boolean DEFAULT true NOT NULL,
    review_tag text,
    analytics_tag text
);


--
-- Name: aug_book_authority_apply_20260813_20260813_161254_daily_work_it; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.aug_book_authority_apply_20260813_20260813_161254_daily_work_it (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: aug_book_authority_apply_20260813_20260813_161254_object_segmen; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.aug_book_authority_apply_20260813_20260813_161254_object_segmen (
    id uuid,
    object_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text
);


--
-- Name: aug_book_authority_apply_20260813_20260813_161254_objects; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.aug_book_authority_apply_20260813_20260813_161254_objects (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: aug_book_authority_apply_20260813_20260813_161254_pile_fields; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.aug_book_authority_apply_20260813_20260813_161254_pile_fields (
    id uuid,
    field_code character varying(100),
    field_type character varying(20),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    pile_type character varying(255),
    pile_count integer,
    dynamic_test_count integer,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    is_demo boolean,
    object_id uuid,
    catalog_status text,
    driven_pile_count integer,
    catalog_review_tag text
);


--
-- Name: aug_book_authority_apply_20260813_20260813_161254_pile_plan_per; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.aug_book_authority_apply_20260813_20260813_161254_pile_plan_per (
    id uuid,
    section_id uuid,
    pile_field_id uuid,
    period_start date,
    period_end date,
    plan_type character varying(32),
    planned_main_piles integer,
    planned_test_piles integer,
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    planned_dynamic_tests integer,
    planned_headcaps integer
);


--
-- Name: aug_book_authority_apply_20260813_20260813_161254_planned_work_; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.aug_book_authority_apply_20260813_20260813_161254_planned_work_ (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    source_project_work_item_id uuid,
    source_pile_field_id uuid,
    source_pile_plan_period_id uuid,
    source_reference text,
    unit character varying(50),
    planned_volume numeric(18,3),
    period_start date,
    period_end date,
    plan_type character varying(30),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: aug_book_authority_apply_20260813_20260813_161254_project_work_; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.aug_book_authority_apply_20260813_20260813_161254_project_work_ (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    project_volume numeric(18,3),
    unit character varying(50),
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    source_pile_field_id uuid
);


--
-- Name: corr6_20260622_20260622_135304_dwi; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.corr6_20260622_20260622_135304_dwi (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: corr6_20260622_20260622_135304_meta; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.corr6_20260622_20260622_135304_meta (
    payload jsonb
);


--
-- Name: corr6_20260622_20260622_135304_segments; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.corr6_20260622_20260622_135304_segments (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: fact_corr_20260619_084239_dwi; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.fact_corr_20260619_084239_dwi (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: fact_corr_20260619_084239_seg; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.fact_corr_20260619_084239_seg (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: fact_corr_20260619_084349_dwi; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.fact_corr_20260619_084349_dwi (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: fact_corr_20260619_084349_seg; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.fact_corr_20260619_084349_seg (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: fact_corr_20260619_084504_dwi; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.fact_corr_20260619_084504_dwi (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: fact_corr_20260619_084504_seg; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.fact_corr_20260619_084504_seg (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: fact_corr_20260619_084645_dwi; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.fact_corr_20260619_084645_dwi (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: fact_corr_20260619_084645_seg; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.fact_corr_20260619_084645_seg (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: pile_access_sync_20260619_071954_object_segments; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_access_sync_20260619_071954_object_segments (
    id uuid,
    object_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text
);


--
-- Name: pile_access_sync_20260619_071954_objects; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_access_sync_20260619_071954_objects (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: pile_access_sync_20260619_072134_legacy_pf_name_fix_objects; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_access_sync_20260619_072134_legacy_pf_name_fix_objects (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: pile_catalog_full_sync_20260615_20260615_111215_daily_work_item; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260615_20260615_111215_daily_work_item (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: pile_catalog_full_sync_20260615_20260615_111215_object_segments; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260615_20260615_111215_object_segments (
    id uuid,
    object_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text
);


--
-- Name: pile_catalog_full_sync_20260615_20260615_111215_objects; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260615_20260615_111215_objects (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: pile_catalog_full_sync_20260615_20260615_111215_pile_fields; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260615_20260615_111215_pile_fields (
    id uuid,
    field_code character varying(100),
    field_type character varying(20),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    pile_type character varying(255),
    pile_count integer,
    dynamic_test_count integer,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    is_demo boolean,
    object_id uuid,
    catalog_status text,
    driven_pile_count integer,
    catalog_review_tag text
);


--
-- Name: pile_catalog_full_sync_20260615_20260615_111215_pile_plan_perio; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260615_20260615_111215_pile_plan_perio (
    id uuid,
    section_id uuid,
    pile_field_id uuid,
    period_start date,
    period_end date,
    plan_type character varying(32),
    planned_main_piles integer,
    planned_test_piles integer,
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    planned_dynamic_tests integer,
    planned_headcaps integer
);


--
-- Name: pile_catalog_full_sync_20260615_20260615_111215_planned_work_it; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260615_20260615_111215_planned_work_it (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    source_project_work_item_id uuid,
    source_pile_field_id uuid,
    source_pile_plan_period_id uuid,
    source_reference text,
    unit character varying(50),
    planned_volume numeric(18,3),
    period_start date,
    period_end date,
    plan_type character varying(30),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: pile_catalog_full_sync_20260615_20260615_111215_project_work_it; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260615_20260615_111215_project_work_it (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    project_volume numeric(18,3),
    unit character varying(50),
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    source_pile_field_id uuid
);


--
-- Name: pile_catalog_full_sync_20260615_20260615_111549_daily_work_item; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260615_20260615_111549_daily_work_item (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: pile_catalog_full_sync_20260615_20260615_111549_object_segments; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260615_20260615_111549_object_segments (
    id uuid,
    object_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text
);


--
-- Name: pile_catalog_full_sync_20260615_20260615_111549_objects; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260615_20260615_111549_objects (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: pile_catalog_full_sync_20260615_20260615_111549_pile_fields; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260615_20260615_111549_pile_fields (
    id uuid,
    field_code character varying(100),
    field_type character varying(20),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    pile_type character varying(255),
    pile_count integer,
    dynamic_test_count integer,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    is_demo boolean,
    object_id uuid,
    catalog_status text,
    driven_pile_count integer,
    catalog_review_tag text
);


--
-- Name: pile_catalog_full_sync_20260615_20260615_111549_pile_plan_perio; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260615_20260615_111549_pile_plan_perio (
    id uuid,
    section_id uuid,
    pile_field_id uuid,
    period_start date,
    period_end date,
    plan_type character varying(32),
    planned_main_piles integer,
    planned_test_piles integer,
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    planned_dynamic_tests integer,
    planned_headcaps integer
);


--
-- Name: pile_catalog_full_sync_20260615_20260615_111549_planned_work_it; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260615_20260615_111549_planned_work_it (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    source_project_work_item_id uuid,
    source_pile_field_id uuid,
    source_pile_plan_period_id uuid,
    source_reference text,
    unit character varying(50),
    planned_volume numeric(18,3),
    period_start date,
    period_end date,
    plan_type character varying(30),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: pile_catalog_full_sync_20260615_20260615_111549_project_work_it; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260615_20260615_111549_project_work_it (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    project_volume numeric(18,3),
    unit character varying(50),
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    source_pile_field_id uuid
);


--
-- Name: pile_catalog_full_sync_20260706_20260706_110718_daily_work_item; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260706_20260706_110718_daily_work_item (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: pile_catalog_full_sync_20260706_20260706_110718_object_segments; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260706_20260706_110718_object_segments (
    id uuid,
    object_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text
);


--
-- Name: pile_catalog_full_sync_20260706_20260706_110718_objects; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260706_20260706_110718_objects (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: pile_catalog_full_sync_20260706_20260706_110718_pile_fields; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260706_20260706_110718_pile_fields (
    id uuid,
    field_code character varying(100),
    field_type character varying(20),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    pile_type character varying(255),
    pile_count integer,
    dynamic_test_count integer,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    is_demo boolean,
    object_id uuid,
    catalog_status text,
    driven_pile_count integer,
    catalog_review_tag text
);


--
-- Name: pile_catalog_full_sync_20260706_20260706_110718_pile_plan_perio; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260706_20260706_110718_pile_plan_perio (
    id uuid,
    section_id uuid,
    pile_field_id uuid,
    period_start date,
    period_end date,
    plan_type character varying(32),
    planned_main_piles integer,
    planned_test_piles integer,
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    planned_dynamic_tests integer,
    planned_headcaps integer
);


--
-- Name: pile_catalog_full_sync_20260706_20260706_110718_planned_work_it; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260706_20260706_110718_planned_work_it (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    source_project_work_item_id uuid,
    source_pile_field_id uuid,
    source_pile_plan_period_id uuid,
    source_reference text,
    unit character varying(50),
    planned_volume numeric(18,3),
    period_start date,
    period_end date,
    plan_type character varying(30),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: pile_catalog_full_sync_20260706_20260706_110718_project_work_it; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_full_sync_20260706_20260706_110718_project_work_it (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    project_volume numeric(18,3),
    unit character varying(50),
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    source_pile_field_id uuid
);


--
-- Name: pile_catalog_owner_commit_20260707_20260707_192010_daily_work_i; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_owner_commit_20260707_20260707_192010_daily_work_i (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: pile_catalog_owner_commit_20260707_20260707_192010_object_segme; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_owner_commit_20260707_20260707_192010_object_segme (
    id uuid,
    object_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text
);


--
-- Name: pile_catalog_owner_commit_20260707_20260707_192010_objects; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_owner_commit_20260707_20260707_192010_objects (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: pile_catalog_owner_commit_20260707_20260707_192010_pile_fields; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_owner_commit_20260707_20260707_192010_pile_fields (
    id uuid,
    field_code character varying(100),
    field_type character varying(20),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    pile_type character varying(255),
    pile_count integer,
    dynamic_test_count integer,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    is_demo boolean,
    object_id uuid,
    catalog_status text,
    driven_pile_count integer,
    catalog_review_tag text
);


--
-- Name: pile_catalog_owner_commit_20260707_20260707_192010_pile_plan_pe; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_owner_commit_20260707_20260707_192010_pile_plan_pe (
    id uuid,
    section_id uuid,
    pile_field_id uuid,
    period_start date,
    period_end date,
    plan_type character varying(32),
    planned_main_piles integer,
    planned_test_piles integer,
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    planned_dynamic_tests integer,
    planned_headcaps integer
);


--
-- Name: pile_catalog_owner_commit_20260707_20260707_192010_planned_work; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_owner_commit_20260707_20260707_192010_planned_work (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    source_project_work_item_id uuid,
    source_pile_field_id uuid,
    source_pile_plan_period_id uuid,
    source_reference text,
    unit character varying(50),
    planned_volume numeric(18,3),
    period_start date,
    period_end date,
    plan_type character varying(30),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: pile_catalog_owner_commit_20260707_20260707_192010_project_work; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_owner_commit_20260707_20260707_192010_project_work (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    project_volume numeric(18,3),
    unit character varying(50),
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    source_pile_field_id uuid
);


--
-- Name: pile_catalog_reconcile_20260530_daily_work_item_segments; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_reconcile_20260530_daily_work_item_segments (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: pile_catalog_reconcile_20260530_daily_work_items; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_reconcile_20260530_daily_work_items (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: pile_catalog_reconcile_20260530_objects; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_reconcile_20260530_objects (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: pile_catalog_reconcile_20260530_pile_fields; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_reconcile_20260530_pile_fields (
    id uuid,
    field_code character varying(100),
    field_type character varying(20),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    pile_type character varying(255),
    pile_count integer,
    dynamic_test_count integer,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    is_demo boolean,
    object_id uuid
);


--
-- Name: pile_catalog_reconcile_20260530_pile_plan_periods; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_reconcile_20260530_pile_plan_periods (
    id uuid,
    section_id uuid,
    pile_field_id uuid,
    period_start date,
    period_end date,
    plan_type character varying(32),
    planned_main_piles integer,
    planned_test_piles integer,
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    planned_dynamic_tests integer,
    planned_headcaps integer
);


--
-- Name: pile_catalog_review_20260615_20260615_100512_daily_work_item_se; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_review_20260615_20260615_100512_daily_work_item_se (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: pile_catalog_review_20260615_20260615_100512_object_segments; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_review_20260615_20260615_100512_object_segments (
    id uuid,
    object_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    review_tag text
);


--
-- Name: pile_catalog_review_20260615_20260615_100512_objects; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_review_20260615_20260615_100512_objects (
    id uuid,
    object_code character varying(100),
    name character varying(255),
    object_type_id uuid,
    constructive_id uuid,
    is_active boolean,
    comment text,
    created_at timestamp with time zone,
    review_tag text
);


--
-- Name: pile_catalog_review_20260615_20260615_100512_pile_fields; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_review_20260615_20260615_100512_pile_fields (
    id uuid,
    field_code character varying(100),
    field_type character varying(20),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    pile_type character varying(255),
    pile_count integer,
    dynamic_test_count integer,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    is_demo boolean,
    object_id uuid,
    catalog_status text,
    driven_pile_count integer,
    catalog_review_tag text
);


--
-- Name: pile_catalog_review_20260615_20260615_100512_pile_plan_periods; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_review_20260615_20260615_100512_pile_plan_periods (
    id uuid,
    section_id uuid,
    pile_field_id uuid,
    period_start date,
    period_end date,
    plan_type character varying(32),
    planned_main_piles integer,
    planned_test_piles integer,
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    planned_dynamic_tests integer,
    planned_headcaps integer
);


--
-- Name: pile_catalog_review_20260615_20260615_100512_planned_work_items; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_review_20260615_20260615_100512_planned_work_items (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    source_project_work_item_id uuid,
    source_pile_field_id uuid,
    source_pile_plan_period_id uuid,
    source_reference text,
    unit character varying(50),
    planned_volume numeric(18,3),
    period_start date,
    period_end date,
    plan_type character varying(30),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    is_active boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: pile_catalog_review_20260615_20260615_100512_project_work_items; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_catalog_review_20260615_20260615_100512_project_work_items (
    id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    project_volume numeric(18,3),
    unit character varying(50),
    source_reference text,
    comment text,
    created_at timestamp with time zone,
    source_pile_field_id uuid
);


--
-- Name: pile_field_status_columns_20260601_pile_fields; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_field_status_columns_20260601_pile_fields (
    id uuid,
    field_code character varying(100),
    field_type character varying(20),
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    pile_type character varying(255),
    pile_count integer,
    dynamic_test_count integer,
    comment text,
    created_at timestamp with time zone,
    start_lat double precision,
    start_lng double precision,
    end_lat double precision,
    end_lng double precision,
    is_demo boolean,
    object_id uuid
);


--
-- Name: pile_main_test_segment_transfer_20260601_daily_work_item_segmen; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_main_test_segment_transfer_20260601_daily_work_item_segmen (
    id uuid,
    daily_work_item_id uuid,
    pk_start numeric(12,2),
    pk_end numeric(12,2),
    pk_raw_text text,
    comment text,
    created_at timestamp with time zone,
    volume_segment numeric(18,3),
    is_demo boolean,
    pile_field_id uuid,
    review_tag text,
    analytics_tag text
);


--
-- Name: pile_main_test_segment_transfer_20260601_daily_work_items; Type: TABLE; Schema: valera_backups; Owner: -
--

CREATE TABLE valera_backups.pile_main_test_segment_transfer_20260601_daily_work_items (
    id uuid,
    daily_report_id uuid,
    report_date date,
    shift character varying(20),
    section_id uuid,
    object_id uuid,
    constructive_id uuid,
    work_type_id uuid,
    work_name_raw text,
    unit character varying(50),
    volume numeric(18,3),
    labor_source_type character varying(20),
    contractor_name character varying(255),
    comment text,
    approved_by character varying(255),
    approved_at timestamp with time zone,
    created_at timestamp with time zone,
    is_demo boolean,
    productivity_enabled boolean,
    review_tag text,
    analytics_tag text
);


--
-- Name: equipment_identifier_chain_cleanup_20260825 id; Type: DEFAULT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_identifier_chain_cleanup_20260825 ALTER COLUMN id SET DEFAULT nextval('audit_backup.equipment_identifier_chain_cleanup_20260825_id_seq'::regclass);


--
-- Name: equipment_master_dedupe_20260827 id; Type: DEFAULT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_master_dedupe_20260827 ALTER COLUMN id SET DEFAULT nextval('audit_backup.equipment_master_dedupe_20260827_id_seq'::regclass);


--
-- Name: db_change_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.db_change_audit ALTER COLUMN id SET DEFAULT nextval('public.db_change_audit_id_seq'::regclass);


--
-- Name: route_pickets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_pickets ALTER COLUMN id SET DEFAULT nextval('public.route_pickets_id_seq'::regclass);


--
-- Name: bk_equipment_merge_20260814_pairs bk_equipment_merge_20260814_pairs_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.bk_equipment_merge_20260814_pairs
    ADD CONSTRAINT bk_equipment_merge_20260814_pairs_pkey PRIMARY KEY (loser_id);


--
-- Name: equipment_identifier_chain_cleanup_20260825 equipment_identifier_chain_cleanup_20260825_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_identifier_chain_cleanup_20260825
    ADD CONSTRAINT equipment_identifier_chain_cleanup_20260825_pkey PRIMARY KEY (id);


--
-- Name: equipment_master_dedupe_20260827 equipment_master_dedupe_20260827_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_master_dedupe_20260827
    ADD CONSTRAINT equipment_master_dedupe_20260827_pkey PRIMARY KEY (id);


--
-- Name: equipment_operation_metrics_split_506_723_backup_20260825 equipment_operation_metrics_s_source_reference_source_sheet_key; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_operation_metrics_split_506_723_backup_20260825
    ADD CONSTRAINT equipment_operation_metrics_s_source_reference_source_sheet_key UNIQUE (source_reference, source_sheet, source_row_number);


--
-- Name: equipment_operation_metrics_split_506_723_backup_20260825 equipment_operation_metrics_split_506_723_backup_20260825_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_operation_metrics_split_506_723_backup_20260825
    ADD CONSTRAINT equipment_operation_metrics_split_506_723_backup_20260825_pkey PRIMARY KEY (id);


--
-- Name: equipment_plate_in_unit_review_payload_20260827 equipment_plate_in_unit_review_payload_20260827_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_plate_in_unit_review_payload_20260827
    ADD CONSTRAINT equipment_plate_in_unit_review_payload_20260827_pkey PRIMARY KEY (daily_report_id);


--
-- Name: equipment_unit_identifiers_inactive_unit_backup_20260818 equipment_unit_identifiers_in_equipment_unit_id_identifier__key; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_unit_identifiers_inactive_unit_backup_20260818
    ADD CONSTRAINT equipment_unit_identifiers_in_equipment_unit_id_identifier__key UNIQUE (equipment_unit_id, identifier_type, normalized_value);


--
-- Name: equipment_unit_identifiers_inactive_unit_backup_20260818 equipment_unit_identifiers_inactive_unit_backup_20260818_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_unit_identifiers_inactive_unit_backup_20260818
    ADD CONSTRAINT equipment_unit_identifiers_inactive_unit_backup_20260818_pkey PRIMARY KEY (id);


--
-- Name: equipment_unit_identifiers_plate_equals_vin_backup_20260818 equipment_unit_identifiers_pl_equipment_unit_id_identifier__key; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_unit_identifiers_plate_equals_vin_backup_20260818
    ADD CONSTRAINT equipment_unit_identifiers_pl_equipment_unit_id_identifier__key UNIQUE (equipment_unit_id, identifier_type, normalized_value);


--
-- Name: equipment_unit_identifiers_plate_equals_vin_backup_20260818 equipment_unit_identifiers_plate_equals_vin_backup_2026081_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_unit_identifiers_plate_equals_vin_backup_20260818
    ADD CONSTRAINT equipment_unit_identifiers_plate_equals_vin_backup_2026081_pkey PRIMARY KEY (id);


--
-- Name: equipment_unit_identifiers_split_506_723_backup_20260825 equipment_unit_identifiers_sp_equipment_unit_id_identifier__key; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_unit_identifiers_split_506_723_backup_20260825
    ADD CONSTRAINT equipment_unit_identifiers_sp_equipment_unit_id_identifier__key UNIQUE (equipment_unit_id, identifier_type, normalized_value);


--
-- Name: equipment_unit_identifiers_split_506_723_backup_20260825 equipment_unit_identifiers_split_506_723_backup_20260825_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_unit_identifiers_split_506_723_backup_20260825
    ADD CONSTRAINT equipment_unit_identifiers_split_506_723_backup_20260825_pkey PRIMARY KEY (id);


--
-- Name: equipment_unit_link_dedup_backup_20260817 equipment_unit_link_dedup_backup_20260817_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_unit_link_dedup_backup_20260817
    ADD CONSTRAINT equipment_unit_link_dedup_backup_20260817_pkey PRIMARY KEY (table_name, row_id);


--
-- Name: equipment_units_plate_equals_vin_backup_20260818 equipment_units_plate_equals_vin_backup_20260818_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_units_plate_equals_vin_backup_20260818
    ADD CONSTRAINT equipment_units_plate_equals_vin_backup_20260818_pkey PRIMARY KEY (id);


--
-- Name: equipment_units_split_506_723_backup_20260825 equipment_units_split_506_723_backup_20260825_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.equipment_units_split_506_723_backup_20260825
    ADD CONSTRAINT equipment_units_split_506_723_backup_20260825_pkey PRIMARY KEY (id);


--
-- Name: planned_work_items_pile_total_mirrors_backup_20260818 planned_work_items_pile_total_mirrors_backup_20260818_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.planned_work_items_pile_total_mirrors_backup_20260818
    ADD CONSTRAINT planned_work_items_pile_total_mirrors_backup_20260818_pkey PRIMARY KEY (id);


--
-- Name: report_equipment_units_split_506_723_backup_20260825 report_equipment_units_split_506_723_backup_20260825_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.report_equipment_units_split_506_723_backup_20260825
    ADD CONSTRAINT report_equipment_units_split_506_723_backup_20260825_pkey PRIMARY KEY (id);


--
-- Name: work_type_aliases_bad_material_canonical_backup_20260824 work_type_aliases_bad_material_canonical_backup_20260824_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.work_type_aliases_bad_material_canonical_backup_20260824
    ADD CONSTRAINT work_type_aliases_bad_material_canonical_backup_20260824_pkey PRIMARY KEY (id);


--
-- Name: work_type_aliases_bad_material_canonical_backup_20260824 work_type_aliases_bad_material_canonical_backup__alias_text_key; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.work_type_aliases_bad_material_canonical_backup_20260824
    ADD CONSTRAINT work_type_aliases_bad_material_canonical_backup__alias_text_key UNIQUE (alias_text);


--
-- Name: work_type_aliases_bad_material_wrapped_backup_20260824 work_type_aliases_bad_material_wrapped_backup_20260824_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.work_type_aliases_bad_material_wrapped_backup_20260824
    ADD CONSTRAINT work_type_aliases_bad_material_wrapped_backup_20260824_pkey PRIMARY KEY (id);


--
-- Name: work_type_aliases_bad_material_wrapped_backup_20260824 work_type_aliases_bad_material_wrapped_backup_20_alias_text_key; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.work_type_aliases_bad_material_wrapped_backup_20260824
    ADD CONSTRAINT work_type_aliases_bad_material_wrapped_backup_20_alias_text_key UNIQUE (alias_text);


--
-- Name: work_type_aliases_before_all_reports_alias_learning_20260824_10 work_type_aliases_before_all_reports_alias_learn_alias_text_key; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.work_type_aliases_before_all_reports_alias_learning_20260824_10
    ADD CONSTRAINT work_type_aliases_before_all_reports_alias_learn_alias_text_key UNIQUE (alias_text);


--
-- Name: work_type_aliases_before_all_reports_alias_learning_20260824_10 work_type_aliases_before_all_reports_alias_learning_202608_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.work_type_aliases_before_all_reports_alias_learning_20260824_10
    ADD CONSTRAINT work_type_aliases_before_all_reports_alias_learning_202608_pkey PRIMARY KEY (id);


--
-- Name: work_type_aliases_material_conflict_backup_20260824 work_type_aliases_material_conflict_backup_20260824_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.work_type_aliases_material_conflict_backup_20260824
    ADD CONSTRAINT work_type_aliases_material_conflict_backup_20260824_pkey PRIMARY KEY (id);


--
-- Name: work_type_aliases_material_conflict_backup_20260824 work_type_aliases_material_conflict_backup_20260_alias_text_key; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.work_type_aliases_material_conflict_backup_20260824
    ADD CONSTRAINT work_type_aliases_material_conflict_backup_20260_alias_text_key UNIQUE (alias_text);


--
-- Name: work_type_aliases_normalized_duplicate_backup_20260818 work_type_aliases_normalized_duplicate_backup_20260818_pkey; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.work_type_aliases_normalized_duplicate_backup_20260818
    ADD CONSTRAINT work_type_aliases_normalized_duplicate_backup_20260818_pkey PRIMARY KEY (id);


--
-- Name: work_type_aliases_normalized_duplicate_backup_20260818 work_type_aliases_normalized_duplicate_backup_20_alias_text_key; Type: CONSTRAINT; Schema: audit_backup; Owner: -
--

ALTER TABLE ONLY audit_backup.work_type_aliases_normalized_duplicate_backup_20260818
    ADD CONSTRAINT work_type_aliases_normalized_duplicate_backup_20_alias_text_key UNIQUE (alias_text);


--
-- Name: analytics_work_category_rules analytics_work_category_rules_category_code_source_kind_sou_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_work_category_rules
    ADD CONSTRAINT analytics_work_category_rules_category_code_source_kind_sou_key UNIQUE (category_code, source_kind, source_code);


--
-- Name: analytics_work_category_rules analytics_work_category_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_work_category_rules
    ADD CONSTRAINT analytics_work_category_rules_pkey PRIMARY KEY (id);


--
-- Name: construction_section_versions construction_section_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_section_versions
    ADD CONSTRAINT construction_section_versions_pkey PRIMARY KEY (id);


--
-- Name: construction_sections construction_sections_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_sections
    ADD CONSTRAINT construction_sections_code_key UNIQUE (code);


--
-- Name: construction_sections construction_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_sections
    ADD CONSTRAINT construction_sections_pkey PRIMARY KEY (id);


--
-- Name: constructive_work_types constructive_work_types_constructive_id_work_type_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constructive_work_types
    ADD CONSTRAINT constructive_work_types_constructive_id_work_type_id_key UNIQUE (constructive_id, work_type_id);


--
-- Name: constructive_work_types constructive_work_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constructive_work_types
    ADD CONSTRAINT constructive_work_types_pkey PRIMARY KEY (id);


--
-- Name: constructives constructives_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constructives
    ADD CONSTRAINT constructives_code_key UNIQUE (code);


--
-- Name: constructives constructives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constructives
    ADD CONSTRAINT constructives_pkey PRIMARY KEY (id);


--
-- Name: contractors contractors_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractors
    ADD CONSTRAINT contractors_name_key UNIQUE (name);


--
-- Name: contractors contractors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractors
    ADD CONSTRAINT contractors_pkey PRIMARY KEY (id);


--
-- Name: daily_report_parse_candidates daily_report_parse_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_parse_candidates
    ADD CONSTRAINT daily_report_parse_candidates_pkey PRIMARY KEY (id);


--
-- Name: daily_report_problems daily_report_problems_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_problems
    ADD CONSTRAINT daily_report_problems_pkey PRIMARY KEY (id);


--
-- Name: daily_report_quality_metrics daily_report_quality_metrics_daily_report_id_text_metric_ki_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_quality_metrics
    ADD CONSTRAINT daily_report_quality_metrics_daily_report_id_text_metric_ki_key UNIQUE (daily_report_id_text, metric_kind);


--
-- Name: daily_report_quality_metrics daily_report_quality_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_quality_metrics
    ADD CONSTRAINT daily_report_quality_metrics_pkey PRIMARY KEY (id);


--
-- Name: daily_report_quality_snapshots daily_report_quality_snapshot_daily_report_id_text_snapshot_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_quality_snapshots
    ADD CONSTRAINT daily_report_quality_snapshot_daily_report_id_text_snapshot_key UNIQUE (daily_report_id_text, snapshot_kind);


--
-- Name: daily_report_quality_snapshots daily_report_quality_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_quality_snapshots
    ADD CONSTRAINT daily_report_quality_snapshots_pkey PRIMARY KEY (id);


--
-- Name: daily_report_review_payload_versions daily_report_review_payload_v_daily_report_id_text_version__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_review_payload_versions
    ADD CONSTRAINT daily_report_review_payload_v_daily_report_id_text_version__key UNIQUE (daily_report_id_text, version_no);


--
-- Name: daily_report_review_payload_versions daily_report_review_payload_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_review_payload_versions
    ADD CONSTRAINT daily_report_review_payload_versions_pkey PRIMARY KEY (id);


--
-- Name: daily_report_staff_counts daily_report_staff_counts_daily_report_id_category_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_staff_counts
    ADD CONSTRAINT daily_report_staff_counts_daily_report_id_category_key UNIQUE (daily_report_id, category);


--
-- Name: daily_report_staff_counts daily_report_staff_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_staff_counts
    ADD CONSTRAINT daily_report_staff_counts_pkey PRIMARY KEY (id);


--
-- Name: daily_reports daily_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_reports
    ADD CONSTRAINT daily_reports_pkey PRIMARY KEY (id);


--
-- Name: daily_section_rating_mstroy_convergence daily_section_rating_mstroy_c_rating_date_scope_section_cod_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_section_rating_mstroy_convergence
    ADD CONSTRAINT daily_section_rating_mstroy_c_rating_date_scope_section_cod_key UNIQUE (rating_date, scope, section_code);


--
-- Name: daily_section_rating_mstroy_convergence daily_section_rating_mstroy_convergence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_section_rating_mstroy_convergence
    ADD CONSTRAINT daily_section_rating_mstroy_convergence_pkey PRIMARY KEY (id);


--
-- Name: daily_work_item_segments daily_work_item_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_work_item_segments
    ADD CONSTRAINT daily_work_item_segments_pkey PRIMARY KEY (id);


--
-- Name: daily_work_items daily_work_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_work_items
    ADD CONSTRAINT daily_work_items_pkey PRIMARY KEY (id);


--
-- Name: dashboard_people_rows dashboard_people_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_people_rows
    ADD CONSTRAINT dashboard_people_rows_pkey PRIMARY KEY (id);


--
-- Name: dashboard_people_snapshots dashboard_people_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_people_snapshots
    ADD CONSTRAINT dashboard_people_snapshots_pkey PRIMARY KEY (id);


--
-- Name: dashboard_response_cache dashboard_response_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_response_cache
    ADD CONSTRAINT dashboard_response_cache_pkey PRIMARY KEY (endpoint, cache_key, fingerprint);


--
-- Name: dashboard_response_cache_state dashboard_response_cache_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_response_cache_state
    ADD CONSTRAINT dashboard_response_cache_state_pkey PRIMARY KEY (cache_scope);


--
-- Name: dashboard_settings dashboard_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_settings
    ADD CONSTRAINT dashboard_settings_pkey PRIMARY KEY (key);


--
-- Name: db_change_audit db_change_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.db_change_audit
    ADD CONSTRAINT db_change_audit_pkey PRIMARY KEY (id);


--
-- Name: equipment_conflict_cleanup_identifiers_backup equipment_conflict_cleanup_identifiers_backup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_conflict_cleanup_identifiers_backup
    ADD CONSTRAINT equipment_conflict_cleanup_identifiers_backup_pkey PRIMARY KEY (cleanup_tag, id);


--
-- Name: equipment_conflict_cleanup_metrics_backup equipment_conflict_cleanup_metrics_backup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_conflict_cleanup_metrics_backup
    ADD CONSTRAINT equipment_conflict_cleanup_metrics_backup_pkey PRIMARY KEY (cleanup_tag, id);


--
-- Name: equipment_conflict_cleanup_report_units_backup equipment_conflict_cleanup_report_units_backup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_conflict_cleanup_report_units_backup
    ADD CONSTRAINT equipment_conflict_cleanup_report_units_backup_pkey PRIMARY KEY (cleanup_tag, id);


--
-- Name: equipment_conflict_cleanup_units_backup equipment_conflict_cleanup_units_backup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_conflict_cleanup_units_backup
    ADD CONSTRAINT equipment_conflict_cleanup_units_backup_pkey PRIMARY KEY (cleanup_tag, id);


--
-- Name: equipment_norms_config equipment_norms_config_category_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_norms_config
    ADD CONSTRAINT equipment_norms_config_category_key_key UNIQUE (category, key);


--
-- Name: equipment_norms_config equipment_norms_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_norms_config
    ADD CONSTRAINT equipment_norms_config_pkey PRIMARY KEY (id);


--
-- Name: equipment_operation_metrics equipment_operation_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_operation_metrics
    ADD CONSTRAINT equipment_operation_metrics_pkey PRIMARY KEY (id);


--
-- Name: equipment_operation_metrics equipment_operation_metrics_source_reference_source_sheet_s_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_operation_metrics
    ADD CONSTRAINT equipment_operation_metrics_source_reference_source_sheet_s_key UNIQUE (source_reference, source_sheet, source_row_number);


--
-- Name: equipment_productivity_norms equipment_productivity_norms_equipment_type_metric_effectiv_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_productivity_norms
    ADD CONSTRAINT equipment_productivity_norms_equipment_type_metric_effectiv_key UNIQUE (equipment_type, metric, effective_from);


--
-- Name: equipment_productivity_norms equipment_productivity_norms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_productivity_norms
    ADD CONSTRAINT equipment_productivity_norms_pkey PRIMARY KEY (id);


--
-- Name: equipment_unit_identifiers equipment_unit_identifiers_equipment_unit_id_identifier_typ_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_unit_identifiers
    ADD CONSTRAINT equipment_unit_identifiers_equipment_unit_id_identifier_typ_key UNIQUE (equipment_unit_id, identifier_type, normalized_value);


--
-- Name: equipment_unit_identifiers equipment_unit_identifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_unit_identifiers
    ADD CONSTRAINT equipment_unit_identifiers_pkey PRIMARY KEY (id);


--
-- Name: equipment_unit_link_6939_split_backup_20260820 equipment_unit_link_6939_split_backup_20260820_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_unit_link_6939_split_backup_20260820
    ADD CONSTRAINT equipment_unit_link_6939_split_backup_20260820_pkey PRIMARY KEY (table_name, row_id);


--
-- Name: equipment_units equipment_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_units
    ADD CONSTRAINT equipment_units_pkey PRIMARY KEY (id);


--
-- Name: isso_front_transfer_lines isso_front_transfer_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.isso_front_transfer_lines
    ADD CONSTRAINT isso_front_transfer_lines_pkey PRIMARY KEY (id);


--
-- Name: isso_front_transfer_monthly_plan isso_front_transfer_monthly_plan_line_id_plan_month_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.isso_front_transfer_monthly_plan
    ADD CONSTRAINT isso_front_transfer_monthly_plan_line_id_plan_month_key UNIQUE (line_id, plan_month);


--
-- Name: isso_front_transfer_monthly_plan isso_front_transfer_monthly_plan_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.isso_front_transfer_monthly_plan
    ADD CONSTRAINT isso_front_transfer_monthly_plan_pkey PRIMARY KEY (id);


--
-- Name: isso_front_transfer_snapshots isso_front_transfer_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.isso_front_transfer_snapshots
    ADD CONSTRAINT isso_front_transfer_snapshots_pkey PRIMARY KEY (id);


--
-- Name: isso_front_transfer_snapshots isso_front_transfer_snapshots_source_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.isso_front_transfer_snapshots
    ADD CONSTRAINT isso_front_transfer_snapshots_source_reference_key UNIQUE (source_reference);


--
-- Name: isso_object_front_attributes isso_object_front_attributes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.isso_object_front_attributes
    ADD CONSTRAINT isso_object_front_attributes_pkey PRIMARY KEY (id);


--
-- Name: isso_object_front_attributes isso_object_front_attributes_snapshot_id_object_id_source_r_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.isso_object_front_attributes
    ADD CONSTRAINT isso_object_front_attributes_snapshot_id_object_id_source_r_key UNIQUE (snapshot_id, object_id, source_row);


--
-- Name: mainline_fill_state_corrections mainline_fill_state_corrections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mainline_fill_state_corrections
    ADD CONSTRAINT mainline_fill_state_corrections_pkey PRIMARY KEY (id);


--
-- Name: mainline_fill_status_segments mainline_fill_status_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mainline_fill_status_segments
    ADD CONSTRAINT mainline_fill_status_segments_pkey PRIMARY KEY (id);


--
-- Name: mainline_rd_coverage mainline_rd_coverage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mainline_rd_coverage
    ADD CONSTRAINT mainline_rd_coverage_pkey PRIMARY KEY (id);


--
-- Name: mainline_work_schedule_ranges mainline_work_schedule_ranges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mainline_work_schedule_ranges
    ADD CONSTRAINT mainline_work_schedule_ranges_pkey PRIMARY KEY (id);


--
-- Name: material_movement_equipment_usage material_movement_equipment_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_movement_equipment_usage
    ADD CONSTRAINT material_movement_equipment_usage_pkey PRIMARY KEY (id);


--
-- Name: material_movements material_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_movements
    ADD CONSTRAINT material_movements_pkey PRIMARY KEY (id);


--
-- Name: materials materials_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.materials
    ADD CONSTRAINT materials_code_key UNIQUE (code);


--
-- Name: materials materials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.materials
    ADD CONSTRAINT materials_pkey PRIMARY KEY (id);


--
-- Name: object_map_points object_map_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.object_map_points
    ADD CONSTRAINT object_map_points_pkey PRIMARY KEY (object_id);


--
-- Name: object_segments object_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.object_segments
    ADD CONSTRAINT object_segments_pkey PRIMARY KEY (id);


--
-- Name: object_type_work_type_defaults object_type_work_type_defaults_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.object_type_work_type_defaults
    ADD CONSTRAINT object_type_work_type_defaults_pkey PRIMARY KEY (mapping_key);


--
-- Name: object_types object_types_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.object_types
    ADD CONSTRAINT object_types_code_key UNIQUE (code);


--
-- Name: object_types object_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.object_types
    ADD CONSTRAINT object_types_pkey PRIMARY KEY (id);


--
-- Name: objects objects_object_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_object_code_key UNIQUE (object_code);


--
-- Name: objects objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_pkey PRIMARY KEY (id);


--
-- Name: parser_learning_cases parser_learning_cases_fingerprint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_learning_cases
    ADD CONSTRAINT parser_learning_cases_fingerprint_key UNIQUE (fingerprint);


--
-- Name: parser_learning_cases parser_learning_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_learning_cases
    ADD CONSTRAINT parser_learning_cases_pkey PRIMARY KEY (id);


--
-- Name: personnel_accommodation_rows personnel_accommodation_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personnel_accommodation_rows
    ADD CONSTRAINT personnel_accommodation_rows_pkey PRIMARY KEY (id);


--
-- Name: personnel_accommodation_snapshots personnel_accommodation_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personnel_accommodation_snapshots
    ADD CONSTRAINT personnel_accommodation_snapshots_pkey PRIMARY KEY (id);


--
-- Name: personnel_accommodation_snapshots personnel_accommodation_snapshots_report_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personnel_accommodation_snapshots
    ADD CONSTRAINT personnel_accommodation_snapshots_report_date_key UNIQUE (report_date);


--
-- Name: pile_delivery_calendar pile_delivery_calendar_delivery_date_supplier_name_raw_spec_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pile_delivery_calendar
    ADD CONSTRAINT pile_delivery_calendar_delivery_date_supplier_name_raw_spec_key UNIQUE (delivery_date, supplier_name, raw_spec_text);


--
-- Name: pile_delivery_calendar pile_delivery_calendar_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pile_delivery_calendar
    ADD CONSTRAINT pile_delivery_calendar_pkey PRIMARY KEY (id);


--
-- Name: pile_delivery_specs pile_delivery_specs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pile_delivery_specs
    ADD CONSTRAINT pile_delivery_specs_pkey PRIMARY KEY (spec_code);


--
-- Name: pile_fields pile_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pile_fields
    ADD CONSTRAINT pile_fields_pkey PRIMARY KEY (id);


--
-- Name: pile_plan_periods pile_plan_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pile_plan_periods
    ADD CONSTRAINT pile_plan_periods_pkey PRIMARY KEY (id);


--
-- Name: pipe_pile_specs pipe_pile_specs_object_id_work_type_id_pile_length_m_source_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipe_pile_specs
    ADD CONSTRAINT pipe_pile_specs_object_id_work_type_id_pile_length_m_source_key UNIQUE (object_id, work_type_id, pile_length_m, source_reference);


--
-- Name: pipe_pile_specs pipe_pile_specs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipe_pile_specs
    ADD CONSTRAINT pipe_pile_specs_pkey PRIMARY KEY (id);


--
-- Name: planned_work_items planned_work_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_work_items
    ADD CONSTRAINT planned_work_items_pkey PRIMARY KEY (id);


--
-- Name: project_work_item_segments project_work_item_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_work_item_segments
    ADD CONSTRAINT project_work_item_segments_pkey PRIMARY KEY (id);


--
-- Name: project_work_items project_work_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_work_items
    ADD CONSTRAINT project_work_items_pkey PRIMARY KEY (id);


--
-- Name: rd_documents rd_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rd_documents
    ADD CONSTRAINT rd_documents_pkey PRIMARY KEY (id);


--
-- Name: rd_publication_links rd_publication_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rd_publication_links
    ADD CONSTRAINT rd_publication_links_pkey PRIMARY KEY (id);


--
-- Name: rd_row_manual_mappings rd_row_manual_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rd_row_manual_mappings
    ADD CONSTRAINT rd_row_manual_mappings_pkey PRIMARY KEY (id);


--
-- Name: rd_rows rd_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rd_rows
    ADD CONSTRAINT rd_rows_pkey PRIMARY KEY (id);


--
-- Name: rd_rows rd_rows_rd_document_id_row_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rd_rows
    ADD CONSTRAINT rd_rows_rd_document_id_row_index_key UNIQUE (rd_document_id, row_index);


--
-- Name: reference_dedup_audit reference_dedup_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reference_dedup_audit
    ADD CONSTRAINT reference_dedup_audit_pkey PRIMARY KEY (id);


--
-- Name: report_equipment_units report_equipment_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_equipment_units
    ADD CONSTRAINT report_equipment_units_pkey PRIMARY KEY (id);


--
-- Name: route_pickets route_pickets_pk_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_pickets
    ADD CONSTRAINT route_pickets_pk_number_key UNIQUE (pk_number);


--
-- Name: route_pickets route_pickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_pickets
    ADD CONSTRAINT route_pickets_pkey PRIMARY KEY (id);


--
-- Name: section_quarry_haul_distances section_quarry_haul_distances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.section_quarry_haul_distances
    ADD CONSTRAINT section_quarry_haul_distances_pkey PRIMARY KEY (section_code, quarry_object_id);


--
-- Name: statement_customer_closed_work_items statement_customer_closed_work_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_customer_closed_work_items
    ADD CONSTRAINT statement_customer_closed_work_items_pkey PRIMARY KEY (id);


--
-- Name: statement_object_unit_rates statement_object_unit_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_object_unit_rates
    ADD CONSTRAINT statement_object_unit_rates_pkey PRIMARY KEY (id);


--
-- Name: stockpile_balance_snapshots stockpile_balance_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stockpile_balance_snapshots
    ADD CONSTRAINT stockpile_balance_snapshots_pkey PRIMARY KEY (id);


--
-- Name: stockpile_balance_snapshots stockpile_balance_snapshots_stockpile_id_snapshot_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stockpile_balance_snapshots
    ADD CONSTRAINT stockpile_balance_snapshots_stockpile_id_snapshot_date_key UNIQUE (stockpile_id, snapshot_date);


--
-- Name: stockpiles stockpiles_object_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stockpiles
    ADD CONSTRAINT stockpiles_object_id_key UNIQUE (object_id);


--
-- Name: stockpiles stockpiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stockpiles
    ADD CONSTRAINT stockpiles_pkey PRIMARY KEY (id);


--
-- Name: temp_road_points temp_road_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temp_road_points
    ADD CONSTRAINT temp_road_points_pkey PRIMARY KEY (id);


--
-- Name: temporary_road_import_drafts temporary_road_import_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_road_import_drafts
    ADD CONSTRAINT temporary_road_import_drafts_pkey PRIMARY KEY (id);


--
-- Name: temporary_road_import_runs temporary_road_import_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_road_import_runs
    ADD CONSTRAINT temporary_road_import_runs_pkey PRIMARY KEY (id);


--
-- Name: temporary_road_pk_mappings temporary_road_pk_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_road_pk_mappings
    ADD CONSTRAINT temporary_road_pk_mappings_pkey PRIMARY KEY (id);


--
-- Name: temporary_road_state_corrections temporary_road_state_corrections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_road_state_corrections
    ADD CONSTRAINT temporary_road_state_corrections_pkey PRIMARY KEY (id);


--
-- Name: temporary_road_status_segments temporary_road_status_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_road_status_segments
    ADD CONSTRAINT temporary_road_status_segments_pkey PRIMARY KEY (id);


--
-- Name: temporary_roads temporary_roads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_roads
    ADD CONSTRAINT temporary_roads_pkey PRIMARY KEY (id);


--
-- Name: temporary_roads temporary_roads_road_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_roads
    ADD CONSTRAINT temporary_roads_road_code_key UNIQUE (road_code);


--
-- Name: work_analytics_tags work_analytics_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_analytics_tags
    ADD CONSTRAINT work_analytics_tags_pkey PRIMARY KEY (name);


--
-- Name: work_item_equipment_usage work_item_equipment_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_item_equipment_usage
    ADD CONSTRAINT work_item_equipment_usage_pkey PRIMARY KEY (id);


--
-- Name: work_type_aliases work_type_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_type_aliases
    ADD CONSTRAINT work_type_aliases_pkey PRIMARY KEY (id);


--
-- Name: work_type_unit_rates work_type_unit_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_type_unit_rates
    ADD CONSTRAINT work_type_unit_rates_pkey PRIMARY KEY (id);


--
-- Name: work_types work_types_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_types
    ADD CONSTRAINT work_types_code_key UNIQUE (code);


--
-- Name: work_types work_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_types
    ADD CONSTRAINT work_types_pkey PRIMARY KEY (id);


--
-- Name: equipment_operation_metrics_s_equipment_unit_id_metric_date_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX equipment_operation_metrics_s_equipment_unit_id_metric_date_idx ON audit_backup.equipment_operation_metrics_split_506_723_backup_20260825 USING btree (equipment_unit_id, metric_date);


--
-- Name: equipment_operation_metrics_split_506_723_backu_metric_date_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX equipment_operation_metrics_split_506_723_backu_metric_date_idx ON audit_backup.equipment_operation_metrics_split_506_723_backup_20260825 USING btree (metric_date);


--
-- Name: equipment_operation_metrics_split_506_72_source_unit_number_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX equipment_operation_metrics_split_506_72_source_unit_number_idx ON audit_backup.equipment_operation_metrics_split_506_723_backup_20260825 USING btree (source_unit_number);


--
-- Name: equipment_operation_metrics_split_506_7_source_plate_number_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX equipment_operation_metrics_split_506_7_source_plate_number_idx ON audit_backup.equipment_operation_metrics_split_506_723_backup_20260825 USING btree (source_plate_number);


--
-- Name: equipment_unit_identifiers_inactive_unit_b_normalized_value_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX equipment_unit_identifiers_inactive_unit_b_normalized_value_idx ON audit_backup.equipment_unit_identifiers_inactive_unit_backup_20260818 USING btree (normalized_value);


--
-- Name: equipment_unit_identifiers_plate_equals_vi_normalized_value_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX equipment_unit_identifiers_plate_equals_vi_normalized_value_idx ON audit_backup.equipment_unit_identifiers_plate_equals_vin_backup_20260818 USING btree (normalized_value);


--
-- Name: equipment_unit_identifiers_split_506_723_b_normalized_value_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX equipment_unit_identifiers_split_506_723_b_normalized_value_idx ON audit_backup.equipment_unit_identifiers_split_506_723_backup_20260825 USING btree (normalized_value);


--
-- Name: equipment_units_plate_equals_vin_back_equipment_type_status_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX equipment_units_plate_equals_vin_back_equipment_type_status_idx ON audit_backup.equipment_units_plate_equals_vin_backup_20260818 USING btree (equipment_type, status);


--
-- Name: equipment_units_split_506_723_backup__equipment_type_status_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX equipment_units_split_506_723_backup__equipment_type_status_idx ON audit_backup.equipment_units_split_506_723_backup_20260825 USING btree (equipment_type, status);


--
-- Name: idx_daily_report_duplicate_candidates_20260818_group; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX idx_daily_report_duplicate_candidates_20260818_group ON audit_backup.daily_report_duplicate_candidates_20260818 USING btree (duplicate_group_no);


--
-- Name: idx_daily_report_duplicate_candidates_20260818_report; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX idx_daily_report_duplicate_candidates_20260818_report ON audit_backup.daily_report_duplicate_candidates_20260818 USING btree (report_id);


--
-- Name: idx_daily_work_item_segment_mismatch_20260818_item; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX idx_daily_work_item_segment_mismatch_20260818_item ON audit_backup.daily_work_item_segment_mismatch_20260818 USING btree (daily_work_item_id);


--
-- Name: idx_daily_work_items_duplicate_candidates_20260818_group; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX idx_daily_work_items_duplicate_candidates_20260818_group ON audit_backup.daily_work_items_duplicate_candidates_20260818 USING btree (duplicate_group_no);


--
-- Name: idx_daily_work_items_duplicate_candidates_20260818_item; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX idx_daily_work_items_duplicate_candidates_20260818_item ON audit_backup.daily_work_items_duplicate_candidates_20260818 USING btree (daily_work_item_id);


--
-- Name: idx_equipment_operation_metrics_kburg_dedup_backup_20260817_id; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE UNIQUE INDEX idx_equipment_operation_metrics_kburg_dedup_backup_20260817_id ON audit_backup.equipment_operation_metrics_kburg_dedup_backup_20260817 USING btree (id);


--
-- Name: idx_equipment_unit_identifiers_dedup_backup_20260817_id; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE UNIQUE INDEX idx_equipment_unit_identifiers_dedup_backup_20260817_id ON audit_backup.equipment_unit_identifiers_dedup_backup_20260817 USING btree (id);


--
-- Name: idx_equipment_unit_identifiers_kburg_dedup_backup_20260817_id; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE UNIQUE INDEX idx_equipment_unit_identifiers_kburg_dedup_backup_20260817_id ON audit_backup.equipment_unit_identifiers_kburg_dedup_backup_20260817 USING btree (id);


--
-- Name: idx_equipment_units_dedup_backup_20260817_id; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE UNIQUE INDEX idx_equipment_units_dedup_backup_20260817_id ON audit_backup.equipment_units_dedup_backup_20260817 USING btree (id);


--
-- Name: idx_equipment_units_kburg_dedup_backup_20260817_id; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE UNIQUE INDEX idx_equipment_units_kburg_dedup_backup_20260817_id ON audit_backup.equipment_units_kburg_dedup_backup_20260817 USING btree (id);


--
-- Name: idx_inactive_object_fact_refs_20260818_fact; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX idx_inactive_object_fact_refs_20260818_fact ON audit_backup.inactive_object_fact_refs_20260818 USING btree (source_table, fact_id);


--
-- Name: idx_inactive_object_fact_refs_20260818_object; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX idx_inactive_object_fact_refs_20260818_object ON audit_backup.inactive_object_fact_refs_20260818 USING btree (object_id);


--
-- Name: idx_material_movements_duplicate_candidates_20260818_group; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX idx_material_movements_duplicate_candidates_20260818_group ON audit_backup.material_movements_duplicate_candidates_20260818 USING btree (duplicate_group_no);


--
-- Name: idx_material_movements_duplicate_candidates_20260818_item; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX idx_material_movements_duplicate_candidates_20260818_item ON audit_backup.material_movements_duplicate_candidates_20260818 USING btree (material_movement_id);


--
-- Name: idx_project_work_item_segment_mismatch_20260818_item; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX idx_project_work_item_segment_mismatch_20260818_item ON audit_backup.project_work_item_segment_mismatch_20260818 USING btree (project_work_item_id);


--
-- Name: idx_report_equipment_units_kburg_dedup_backup_20260817_id; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE UNIQUE INDEX idx_report_equipment_units_kburg_dedup_backup_20260817_id ON audit_backup.report_equipment_units_kburg_dedup_backup_20260817 USING btree (id);


--
-- Name: planned_work_items_pile_total__source_project_work_item_id_idx1; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE UNIQUE INDEX planned_work_items_pile_total__source_project_work_item_id_idx1 ON audit_backup.planned_work_items_pile_total_mirrors_backup_20260818 USING btree (source_project_work_item_id) WHERE ((source_project_work_item_id IS NOT NULL) AND (source_reference = 'project_work_items:total'::text));


--
-- Name: planned_work_items_pile_total_m_source_project_work_item_id_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX planned_work_items_pile_total_m_source_project_work_item_id_idx ON audit_backup.planned_work_items_pile_total_mirrors_backup_20260818 USING btree (source_project_work_item_id) WHERE (source_project_work_item_id IS NOT NULL);


--
-- Name: planned_work_items_pile_total_mi_source_pile_plan_period_id_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX planned_work_items_pile_total_mi_source_pile_plan_period_id_idx ON audit_backup.planned_work_items_pile_total_mirrors_backup_20260818 USING btree (source_pile_plan_period_id) WHERE (source_pile_plan_period_id IS NOT NULL);


--
-- Name: planned_work_items_pile_total_mirro_period_start_period_end_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX planned_work_items_pile_total_mirro_period_start_period_end_idx ON audit_backup.planned_work_items_pile_total_mirrors_backup_20260818 USING btree (period_start, period_end);


--
-- Name: planned_work_items_pile_total_mirror_object_id_work_type_id_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX planned_work_items_pile_total_mirror_object_id_work_type_id_idx ON audit_backup.planned_work_items_pile_total_mirrors_backup_20260818 USING btree (object_id, work_type_id);


--
-- Name: planned_work_items_pile_total_source_pile_plan_period_id_wo_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE UNIQUE INDEX planned_work_items_pile_total_source_pile_plan_period_id_wo_idx ON audit_backup.planned_work_items_pile_total_mirrors_backup_20260818 USING btree (source_pile_plan_period_id, work_type_id) WHERE ((source_pile_plan_period_id IS NOT NULL) AND (source_reference = 'pile_plan_periods:migrated'::text));


--
-- Name: report_equipment_units_split_506_723_back_equipment_unit_id_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX report_equipment_units_split_506_723_back_equipment_unit_id_idx ON audit_backup.report_equipment_units_split_506_723_backup_20260825 USING btree (equipment_unit_id);


--
-- Name: report_equipment_units_split_506_723_backup_20260825_status_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX report_equipment_units_split_506_723_backup_20260825_status_idx ON audit_backup.report_equipment_units_split_506_723_backup_20260825 USING btree (status);


--
-- Name: report_equipment_units_split_506_723_backup_2026082_is_demo_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX report_equipment_units_split_506_723_backup_2026082_is_demo_idx ON audit_backup.report_equipment_units_split_506_723_backup_20260825 USING btree (is_demo);


--
-- Name: report_equipment_units_split_506_723_backup_2_contractor_id_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX report_equipment_units_split_506_723_backup_2_contractor_id_idx ON audit_backup.report_equipment_units_split_506_723_backup_20260825 USING btree (contractor_id);


--
-- Name: report_equipment_units_split_506_723_backup__equipment_type_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX report_equipment_units_split_506_723_backup__equipment_type_idx ON audit_backup.report_equipment_units_split_506_723_backup_20260825 USING btree (equipment_type);


--
-- Name: report_equipment_units_split_506_723_backup_daily_report_id_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE INDEX report_equipment_units_split_506_723_backup_daily_report_id_idx ON audit_backup.report_equipment_units_split_506_723_backup_20260825 USING btree (daily_report_id);


--
-- Name: uq_work_type_aliases_removed_20260909_id; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE UNIQUE INDEX uq_work_type_aliases_removed_20260909_id ON audit_backup.work_type_aliases_removed_20260909 USING btree (id);


--
-- Name: work_type_aliases_bad_materia_canonical_code_kind_regexp_r_idx1; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE UNIQUE INDEX work_type_aliases_bad_materia_canonical_code_kind_regexp_r_idx1 ON audit_backup.work_type_aliases_bad_material_wrapped_backup_20260824 USING btree (canonical_code, kind, regexp_replace(replace(lower(btrim(alias_text)), 'ё'::text, 'е'::text), '\s+'::text, ' '::text, 'g'::text));


--
-- Name: work_type_aliases_bad_materia_canonical_code_kind_regexp_re_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE UNIQUE INDEX work_type_aliases_bad_materia_canonical_code_kind_regexp_re_idx ON audit_backup.work_type_aliases_bad_material_canonical_backup_20260824 USING btree (canonical_code, kind, regexp_replace(replace(lower(btrim(alias_text)), 'ё'::text, 'е'::text), '\s+'::text, ' '::text, 'g'::text));


--
-- Name: work_type_aliases_before_all__canonical_code_kind_regexp_re_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE UNIQUE INDEX work_type_aliases_before_all__canonical_code_kind_regexp_re_idx ON audit_backup.work_type_aliases_before_all_reports_alias_learning_20260824_10 USING btree (canonical_code, kind, regexp_replace(replace(lower(btrim(alias_text)), 'ё'::text, 'е'::text), '\s+'::text, ' '::text, 'g'::text));


--
-- Name: work_type_aliases_material_co_canonical_code_kind_regexp_re_idx; Type: INDEX; Schema: audit_backup; Owner: -
--

CREATE UNIQUE INDEX work_type_aliases_material_co_canonical_code_kind_regexp_re_idx ON audit_backup.work_type_aliases_material_conflict_backup_20260824 USING btree (canonical_code, kind, regexp_replace(replace(lower(btrim(alias_text)), 'ё'::text, 'е'::text), '\s+'::text, ' '::text, 'g'::text));


--
-- Name: idx_analytics_work_category_rules_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analytics_work_category_rules_lookup ON public.analytics_work_category_rules USING btree (category_code, source_kind, source_code);


--
-- Name: idx_candidates_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_candidates_report ON public.daily_report_parse_candidates USING btree (daily_report_id);


--
-- Name: idx_constructive_work_types_work_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_constructive_work_types_work_type_id ON public.constructive_work_types USING btree (work_type_id);


--
-- Name: idx_constructives_object_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_constructives_object_id ON public.constructives USING btree (object_id);


--
-- Name: idx_constructives_object_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_constructives_object_type_id ON public.constructives USING btree (object_type_id);


--
-- Name: idx_contractors_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contractors_kind ON public.contractors USING btree (kind) WHERE (is_active = true);


--
-- Name: idx_contractors_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contractors_name_trgm ON public.contractors USING gin (name public.gin_trgm_ops);


--
-- Name: idx_daily_report_quality_metrics_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_report_quality_metrics_period ON public.daily_report_quality_metrics USING btree (report_date, is_pile_shift_report, calculated_at DESC);


--
-- Name: idx_daily_report_quality_metrics_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_report_quality_metrics_report ON public.daily_report_quality_metrics USING btree (daily_report_id_text, metric_kind);


--
-- Name: idx_daily_report_quality_snapshots_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_report_quality_snapshots_report ON public.daily_report_quality_snapshots USING btree (daily_report_id_text, snapshot_kind);


--
-- Name: idx_daily_report_quality_snapshots_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_report_quality_snapshots_scope ON public.daily_report_quality_snapshots USING btree (is_pile_shift_report, report_date);


--
-- Name: idx_daily_report_review_payload_versions_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_report_review_payload_versions_hash ON public.daily_report_review_payload_versions USING btree (daily_report_id_text, payload_hash);


--
-- Name: idx_daily_report_review_payload_versions_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_report_review_payload_versions_report ON public.daily_report_review_payload_versions USING btree (daily_report_id_text, created_at DESC);


--
-- Name: idx_daily_report_staff_counts_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_report_staff_counts_report ON public.daily_report_staff_counts USING btree (daily_report_id);


--
-- Name: idx_daily_reports_active_import_business_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_reports_active_import_business_key ON public.daily_reports USING btree (report_date, shift, section_id, source_type, source_reference) WHERE ((COALESCE(is_demo, false) = false) AND ((status)::text = ANY ((ARRAY['pending_review'::character varying, 'review'::character varying, 'confirmed'::character varying, 'approved'::character varying])::text[])) AND (NULLIF(btrim(COALESCE(source_reference, ''::text)), ''::text) IS NOT NULL));


--
-- Name: idx_daily_reports_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_reports_date ON public.daily_reports USING btree (report_date);


--
-- Name: idx_daily_reports_is_demo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_reports_is_demo ON public.daily_reports USING btree (is_demo);


--
-- Name: idx_daily_reports_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_reports_section ON public.daily_reports USING btree (section_id, report_date);


--
-- Name: idx_daily_section_rating_mstroy_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_section_rating_mstroy_period ON public.daily_section_rating_mstroy_convergence USING btree (scope, rating_date, section_code);


--
-- Name: idx_daily_work_item_segments_pile_field; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_work_item_segments_pile_field ON public.daily_work_item_segments USING btree (pile_field_id);


--
-- Name: idx_daily_work_item_segments_pile_field_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_work_item_segments_pile_field_id ON public.daily_work_item_segments USING btree (pile_field_id);


--
-- Name: idx_daily_work_items_analytics_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_work_items_analytics_tag ON public.daily_work_items USING btree (analytics_tag);


--
-- Name: idx_daily_work_items_constructive_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_work_items_constructive_id ON public.daily_work_items USING btree (constructive_id);


--
-- Name: idx_daily_work_items_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_work_items_date ON public.daily_work_items USING btree (report_date);


--
-- Name: idx_daily_work_items_is_demo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_work_items_is_demo ON public.daily_work_items USING btree (is_demo);


--
-- Name: idx_daily_work_items_object; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_work_items_object ON public.daily_work_items USING btree (object_id, report_date);


--
-- Name: idx_daily_work_items_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_work_items_report ON public.daily_work_items USING btree (daily_report_id);


--
-- Name: idx_daily_work_items_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_work_items_section ON public.daily_work_items USING btree (section_id, report_date);


--
-- Name: idx_daily_work_items_work_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_work_items_work_type ON public.daily_work_items USING btree (work_type_id, report_date);


--
-- Name: idx_daily_work_segments_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_work_segments_item ON public.daily_work_item_segments USING btree (daily_work_item_id);


--
-- Name: idx_daily_work_segments_range; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_work_segments_range ON public.daily_work_item_segments USING btree (pk_start, pk_end);


--
-- Name: idx_dashboard_people_rows_snapshot_card; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dashboard_people_rows_snapshot_card ON public.dashboard_people_rows USING btree (snapshot_id, card_code, row_type);


--
-- Name: idx_dashboard_people_snapshots_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dashboard_people_snapshots_date ON public.dashboard_people_snapshots USING btree (report_date DESC, imported_at DESC);


--
-- Name: idx_dashboard_response_cache_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dashboard_response_cache_lookup ON public.dashboard_response_cache USING btree (endpoint, cache_key, created_at DESC);


--
-- Name: idx_drp_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drp_report ON public.daily_report_problems USING btree (daily_report_id);


--
-- Name: idx_equipment_operation_metrics_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_equipment_operation_metrics_date ON public.equipment_operation_metrics USING btree (metric_date);


--
-- Name: idx_equipment_operation_metrics_source_plate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_equipment_operation_metrics_source_plate ON public.equipment_operation_metrics USING btree (source_plate_number);


--
-- Name: idx_equipment_operation_metrics_source_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_equipment_operation_metrics_source_unit ON public.equipment_operation_metrics USING btree (source_unit_number);


--
-- Name: idx_equipment_operation_metrics_unit_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_equipment_operation_metrics_unit_date ON public.equipment_operation_metrics USING btree (equipment_unit_id, metric_date);


--
-- Name: idx_equipment_unit_identifiers_6939_split_backup_20260820_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_equipment_unit_identifiers_6939_split_backup_20260820_id ON public.equipment_unit_identifiers_6939_split_backup_20260820 USING btree (id);


--
-- Name: idx_equipment_unit_identifiers_norm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_equipment_unit_identifiers_norm ON public.equipment_unit_identifiers USING btree (normalized_value);


--
-- Name: idx_equipment_units_6939_split_backup_20260820_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_equipment_units_6939_split_backup_20260820_id ON public.equipment_units_6939_split_backup_20260820 USING btree (id);


--
-- Name: idx_equipment_units_type_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_equipment_units_type_status ON public.equipment_units USING btree (equipment_type, status);


--
-- Name: idx_isso_front_attr_object; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_isso_front_attr_object ON public.isso_object_front_attributes USING btree (object_id);


--
-- Name: idx_isso_front_lines_object; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_isso_front_lines_object ON public.isso_front_transfer_lines USING btree (object_id);


--
-- Name: idx_isso_front_lines_unique_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_isso_front_lines_unique_source ON public.isso_front_transfer_lines USING btree (snapshot_id, object_id, source_row, COALESCE(required_sequence_text, ''::text));


--
-- Name: idx_isso_front_plan_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_isso_front_plan_month ON public.isso_front_transfer_monthly_plan USING btree (plan_month);


--
-- Name: idx_isso_transfer_lines_object_attr_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_isso_transfer_lines_object_attr_id ON public.isso_front_transfer_lines USING btree (object_attribute_id);


--
-- Name: idx_mainline_fill_state_corrections_section_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mainline_fill_state_corrections_section_date ON public.mainline_fill_state_corrections USING btree (section_id, effective_date, created_at);


--
-- Name: idx_mainline_fill_status_segments_report_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mainline_fill_status_segments_report_id ON public.mainline_fill_status_segments USING btree (daily_report_id);


--
-- Name: idx_mainline_fill_status_segments_review_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mainline_fill_status_segments_review_tag ON public.mainline_fill_status_segments USING btree (review_tag);


--
-- Name: idx_mainline_fill_status_segments_section_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mainline_fill_status_segments_section_date ON public.mainline_fill_status_segments USING btree (section_id, status_date);


--
-- Name: idx_mainline_rd_coverage_object; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mainline_rd_coverage_object ON public.mainline_rd_coverage USING btree (object_id);


--
-- Name: idx_mainline_rd_coverage_pk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mainline_rd_coverage_pk ON public.mainline_rd_coverage USING btree (pk_start, pk_end);


--
-- Name: idx_mainline_rd_coverage_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mainline_rd_coverage_section ON public.mainline_rd_coverage USING btree (section_id);


--
-- Name: idx_mainline_work_schedule_ranges_object; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mainline_work_schedule_ranges_object ON public.mainline_work_schedule_ranges USING btree (object_id);


--
-- Name: idx_mainline_work_schedule_ranges_pk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mainline_work_schedule_ranges_pk ON public.mainline_work_schedule_ranges USING btree (pk_start, pk_end);


--
-- Name: idx_mainline_work_schedule_ranges_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mainline_work_schedule_ranges_section ON public.mainline_work_schedule_ranges USING btree (section_id);


--
-- Name: idx_material_movements_contractor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_movements_contractor ON public.material_movements USING btree (contractor_id);


--
-- Name: idx_material_movements_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_movements_date ON public.material_movements USING btree (report_date);


--
-- Name: idx_material_movements_from_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_movements_from_to ON public.material_movements USING btree (from_object_id, to_object_id);


--
-- Name: idx_material_movements_haul_distance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_movements_haul_distance ON public.material_movements USING btree (haul_distance_km) WHERE (haul_distance_km IS NOT NULL);


--
-- Name: idx_material_movements_is_demo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_movements_is_demo ON public.material_movements USING btree (is_demo);


--
-- Name: idx_material_movements_material; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_movements_material ON public.material_movements USING btree (material_id, report_date);


--
-- Name: idx_material_movements_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_movements_report ON public.material_movements USING btree (daily_report_id);


--
-- Name: idx_material_movements_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_movements_section ON public.material_movements USING btree (section_id, report_date);


--
-- Name: idx_material_movements_to_object_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_movements_to_object_id ON public.material_movements USING btree (to_object_id);


--
-- Name: idx_movement_equipment_movement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movement_equipment_movement ON public.material_movement_equipment_usage USING btree (material_movement_id);


--
-- Name: idx_movement_equipment_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movement_equipment_unit ON public.material_movement_equipment_usage USING btree (report_equipment_unit_id);


--
-- Name: idx_object_segments_object; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_object_segments_object ON public.object_segments USING btree (object_id);


--
-- Name: idx_object_segments_range; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_object_segments_range ON public.object_segments USING btree (pk_start, pk_end);


--
-- Name: idx_objects_constructive; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_objects_constructive ON public.objects USING btree (constructive_id);


--
-- Name: idx_objects_object_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_objects_object_type ON public.objects USING btree (object_type_id);


--
-- Name: idx_ot_wt_defaults_object_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ot_wt_defaults_object_type_id ON public.object_type_work_type_defaults USING btree (object_type_id);


--
-- Name: idx_ot_wt_defaults_work_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ot_wt_defaults_work_type_id ON public.object_type_work_type_defaults USING btree (work_type_id);


--
-- Name: idx_parser_learning_cases_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parser_learning_cases_report ON public.parser_learning_cases USING btree (daily_report_id);


--
-- Name: idx_parser_learning_cases_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parser_learning_cases_status_created ON public.parser_learning_cases USING btree (status, created_at DESC);


--
-- Name: idx_personnel_accommodation_rows_groups; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_personnel_accommodation_rows_groups ON public.personnel_accommodation_rows USING btree (snapshot_id, settlement, camp_name, facility_type);


--
-- Name: idx_personnel_accommodation_rows_snapshot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_personnel_accommodation_rows_snapshot ON public.personnel_accommodation_rows USING btree (snapshot_id, group_kind, sort_order);


--
-- Name: idx_pile_fields_is_demo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pile_fields_is_demo ON public.pile_fields USING btree (is_demo);


--
-- Name: idx_pile_fields_object_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pile_fields_object_id ON public.pile_fields USING btree (object_id);


--
-- Name: idx_pile_plan_periods_field_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pile_plan_periods_field_period ON public.pile_plan_periods USING btree (pile_field_id, period_start, period_end);


--
-- Name: idx_pile_plan_periods_section_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pile_plan_periods_section_period ON public.pile_plan_periods USING btree (section_id, period_start, period_end);


--
-- Name: idx_planned_work_items_assigned_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planned_work_items_assigned_section ON public.planned_work_items USING btree (assigned_section_id) WHERE (assigned_section_id IS NOT NULL);


--
-- Name: idx_planned_work_items_constructive_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planned_work_items_constructive_id ON public.planned_work_items USING btree (constructive_id);


--
-- Name: idx_planned_work_items_object_work; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planned_work_items_object_work ON public.planned_work_items USING btree (object_id, work_type_id);


--
-- Name: idx_planned_work_items_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planned_work_items_period ON public.planned_work_items USING btree (period_start, period_end);


--
-- Name: idx_planned_work_items_source_pile_field_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planned_work_items_source_pile_field_id ON public.planned_work_items USING btree (source_pile_field_id);


--
-- Name: idx_planned_work_items_source_pile_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planned_work_items_source_pile_period ON public.planned_work_items USING btree (source_pile_plan_period_id) WHERE (source_pile_plan_period_id IS NOT NULL);


--
-- Name: idx_planned_work_items_source_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planned_work_items_source_project ON public.planned_work_items USING btree (source_project_work_item_id) WHERE (source_project_work_item_id IS NOT NULL);


--
-- Name: idx_planned_work_items_work_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planned_work_items_work_type_id ON public.planned_work_items USING btree (work_type_id);


--
-- Name: idx_project_segments_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_segments_item ON public.project_work_item_segments USING btree (project_work_item_id);


--
-- Name: idx_project_segments_range; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_segments_range ON public.project_work_item_segments USING btree (pk_start, pk_end);


--
-- Name: idx_project_work_item_segments_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_work_item_segments_item ON public.project_work_item_segments USING btree (project_work_item_id);


--
-- Name: idx_project_work_item_segments_pk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_work_item_segments_pk ON public.project_work_item_segments USING btree (pk_start, pk_end);


--
-- Name: idx_project_work_items_constructive_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_work_items_constructive_id ON public.project_work_items USING btree (constructive_id);


--
-- Name: idx_project_work_items_object; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_work_items_object ON public.project_work_items USING btree (object_id);


--
-- Name: idx_project_work_items_source_pile_field; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_work_items_source_pile_field ON public.project_work_items USING btree (source_pile_field_id) WHERE (source_pile_field_id IS NOT NULL);


--
-- Name: idx_project_work_items_work_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_work_items_work_type ON public.project_work_items USING btree (work_type_id);


--
-- Name: idx_rd_documents_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rd_documents_created ON public.rd_documents USING btree (created_at DESC);


--
-- Name: idx_rd_documents_default_object_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rd_documents_default_object_id ON public.rd_documents USING btree (default_object_id);


--
-- Name: idx_rd_publication_links_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rd_publication_links_document ON public.rd_publication_links USING btree (rd_document_id);


--
-- Name: idx_rd_publication_links_rd_row_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rd_publication_links_rd_row_id ON public.rd_publication_links USING btree (rd_row_id);


--
-- Name: idx_rd_row_manual_mappings_row; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rd_row_manual_mappings_row ON public.rd_row_manual_mappings USING btree (rd_row_id, created_at DESC);


--
-- Name: idx_rd_rows_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rd_rows_document ON public.rd_rows USING btree (rd_document_id, row_index);


--
-- Name: idx_rd_rows_material_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rd_rows_material_id ON public.rd_rows USING btree (material_id);


--
-- Name: idx_rd_rows_object_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rd_rows_object_id ON public.rd_rows USING btree (object_id);


--
-- Name: idx_rd_rows_work_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rd_rows_work_type_id ON public.rd_rows USING btree (work_type_id);


--
-- Name: idx_report_equipment_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_equipment_report ON public.report_equipment_units USING btree (daily_report_id);


--
-- Name: idx_report_equipment_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_equipment_status ON public.report_equipment_units USING btree (status);


--
-- Name: idx_report_equipment_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_equipment_type ON public.report_equipment_units USING btree (equipment_type);


--
-- Name: idx_report_equipment_units_contractor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_equipment_units_contractor ON public.report_equipment_units USING btree (contractor_id);


--
-- Name: idx_report_equipment_units_is_demo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_equipment_units_is_demo ON public.report_equipment_units USING btree (is_demo);


--
-- Name: idx_report_equipment_units_master; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_equipment_units_master ON public.report_equipment_units USING btree (equipment_unit_id);


--
-- Name: idx_route_pickets_coords; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_route_pickets_coords ON public.route_pickets USING btree (latitude, longitude);


--
-- Name: idx_route_pickets_pk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_route_pickets_pk ON public.route_pickets USING btree (pk_number);


--
-- Name: idx_section_quarry_haul_distances_quarry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_section_quarry_haul_distances_quarry ON public.section_quarry_haul_distances USING btree (quarry_object_id);


--
-- Name: idx_section_versions_current; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_section_versions_current ON public.construction_section_versions USING btree (section_id, is_current);


--
-- Name: idx_section_versions_kind_current; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_section_versions_kind_current ON public.construction_section_versions USING btree (boundary_kind, section_id, is_current);


--
-- Name: idx_section_versions_range; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_section_versions_range ON public.construction_section_versions USING btree (pk_start, pk_end);


--
-- Name: idx_section_versions_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_section_versions_section ON public.construction_section_versions USING btree (section_id);


--
-- Name: idx_statement_customer_closed_work_items_object_work; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_statement_customer_closed_work_items_object_work ON public.statement_customer_closed_work_items USING btree (object_id, work_type_id) WHERE ((is_active IS TRUE) AND (object_id IS NOT NULL) AND (work_type_id IS NOT NULL));


--
-- Name: idx_statement_customer_closed_work_items_period_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_statement_customer_closed_work_items_period_section ON public.statement_customer_closed_work_items USING btree (period_start, period_end, section_code) WHERE (is_active IS TRUE);


--
-- Name: idx_stmt_obj_unit_rates_work_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stmt_obj_unit_rates_work_type_id ON public.statement_object_unit_rates USING btree (work_type_id);


--
-- Name: idx_stockpiles_material_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockpiles_material_id ON public.stockpiles USING btree (material_id);


--
-- Name: idx_temp_road_points_road; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temp_road_points_road ON public.temp_road_points USING btree (road_id, seq_no);


--
-- Name: idx_temp_road_status_is_demo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temp_road_status_is_demo ON public.temporary_road_status_segments USING btree (is_demo);


--
-- Name: idx_temporary_road_status_segments_object_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temporary_road_status_segments_object_id ON public.temporary_road_status_segments USING btree (object_id);


--
-- Name: idx_temporary_road_status_segments_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temporary_road_status_segments_report ON public.temporary_road_status_segments USING btree (daily_report_id);


--
-- Name: idx_temporary_roads_display_in_dashboard; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temporary_roads_display_in_dashboard ON public.temporary_roads USING btree (display_in_dashboard);


--
-- Name: idx_temporary_roads_object_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temporary_roads_object_id ON public.temporary_roads USING btree (object_id);


--
-- Name: idx_work_item_equipment_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_work_item_equipment_unit ON public.work_item_equipment_usage USING btree (report_equipment_unit_id);


--
-- Name: idx_work_item_equipment_usage_one_per_work; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_work_item_equipment_usage_one_per_work ON public.work_item_equipment_usage USING btree (daily_work_item_id);


--
-- Name: idx_work_item_equipment_work; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_work_item_equipment_work ON public.work_item_equipment_usage USING btree (daily_work_item_id);


--
-- Name: pile_delivery_calendar_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pile_delivery_calendar_date_idx ON public.pile_delivery_calendar USING btree (delivery_date);


--
-- Name: pile_delivery_calendar_exclude_from_totals_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pile_delivery_calendar_exclude_from_totals_idx ON public.pile_delivery_calendar USING btree (delivery_date, exclude_from_totals);


--
-- Name: pile_delivery_calendar_spec_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pile_delivery_calendar_spec_idx ON public.pile_delivery_calendar USING btree (spec_code) WHERE (spec_code IS NOT NULL);


--
-- Name: pile_delivery_calendar_supplier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pile_delivery_calendar_supplier_idx ON public.pile_delivery_calendar USING btree (supplier_name, delivery_date);


--
-- Name: pile_fields_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pile_fields_unique_idx ON public.pile_fields USING btree (field_type, field_code, pk_start, pk_end, pile_type);


--
-- Name: pipe_pile_specs_object_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pipe_pile_specs_object_idx ON public.pipe_pile_specs USING btree (object_id) WHERE is_active;


--
-- Name: pipe_pile_specs_work_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pipe_pile_specs_work_type_idx ON public.pipe_pile_specs USING btree (work_type_id) WHERE is_active;


--
-- Name: statement_object_unit_rates_unique_base_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX statement_object_unit_rates_unique_base_idx ON public.statement_object_unit_rates USING btree (object_id, work_type_id, region_code) WHERE (pile_length_m IS NULL);


--
-- Name: statement_object_unit_rates_unique_length_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX statement_object_unit_rates_unique_length_idx ON public.statement_object_unit_rates USING btree (object_id, work_type_id, region_code, pile_length_m) WHERE (pile_length_m IS NOT NULL);


--
-- Name: temporary_road_pk_mappings_road_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX temporary_road_pk_mappings_road_id_idx ON public.temporary_road_pk_mappings USING btree (road_id);


--
-- Name: temporary_road_pk_mappings_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX temporary_road_pk_mappings_unique_idx ON public.temporary_road_pk_mappings USING btree (road_id, mapping_type, ad_pk_start, ad_pk_end, rail_pk_start, rail_pk_end);


--
-- Name: temporary_road_state_corrections_draft_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX temporary_road_state_corrections_draft_idx ON public.temporary_road_state_corrections USING btree (source_draft_id);


--
-- Name: temporary_road_state_corrections_road_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX temporary_road_state_corrections_road_date_idx ON public.temporary_road_state_corrections USING btree (road_id, effective_date);


--
-- Name: temporary_road_status_segments_import_run_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX temporary_road_status_segments_import_run_id_idx ON public.temporary_road_status_segments USING btree (import_run_id);


--
-- Name: temporary_road_status_segments_report_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX temporary_road_status_segments_report_unique_idx ON public.temporary_road_status_segments USING btree (daily_report_id, road_id, status_date, status_type, input_pk_system, COALESCE(road_pk_start, ('-1'::integer)::numeric), COALESCE(road_pk_end, ('-1'::integer)::numeric), COALESCE(rail_pk_start, ('-1'::integer)::numeric), COALESCE(rail_pk_end, ('-1'::integer)::numeric)) WHERE (daily_report_id IS NOT NULL);


--
-- Name: temporary_road_status_segments_road_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX temporary_road_status_segments_road_id_idx ON public.temporary_road_status_segments USING btree (road_id);


--
-- Name: temporary_road_status_segments_status_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX temporary_road_status_segments_status_date_idx ON public.temporary_road_status_segments USING btree (status_date);


--
-- Name: temporary_road_status_segments_status_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX temporary_road_status_segments_status_type_idx ON public.temporary_road_status_segments USING btree (status_type);


--
-- Name: temporary_road_status_segments_unowned_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX temporary_road_status_segments_unowned_unique_idx ON public.temporary_road_status_segments USING btree (road_id, status_date, status_type, input_pk_system, COALESCE(road_pk_start, ('-1'::integer)::numeric), COALESCE(road_pk_end, ('-1'::integer)::numeric), COALESCE(rail_pk_start, ('-1'::integer)::numeric), COALESCE(rail_pk_end, ('-1'::integer)::numeric)) WHERE (daily_report_id IS NULL);


--
-- Name: temporary_roads_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX temporary_roads_section_id_idx ON public.temporary_roads USING btree (section_id);


--
-- Name: uq_planned_work_items_pile_period_work; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_planned_work_items_pile_period_work ON public.planned_work_items USING btree (source_pile_plan_period_id, work_type_id) WHERE ((source_pile_plan_period_id IS NOT NULL) AND (source_reference = 'pile_plan_periods:migrated'::text));


--
-- Name: uq_planned_work_items_source_project_total; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_planned_work_items_source_project_total ON public.planned_work_items USING btree (source_project_work_item_id) WHERE ((source_project_work_item_id IS NOT NULL) AND (source_reference = 'project_work_items:total'::text));


--
-- Name: uq_project_work_items_pile_duplication; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_project_work_items_pile_duplication ON public.project_work_items USING btree (source_pile_field_id, work_type_id) WHERE ((source_reference = 'pile_fields:project_duplication'::text) AND (source_pile_field_id IS NOT NULL));


--
-- Name: uq_statement_customer_closed_work_items_source_match; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_statement_customer_closed_work_items_source_match ON public.statement_customer_closed_work_items USING btree (period_start, period_end, source_file_sha256, source_sheet, source_row, section_code, COALESCE(object_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(work_type_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(unit, ''::text));


--
-- Name: uq_work_type_aliases_kind_normalized; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_work_type_aliases_kind_normalized ON public.work_type_aliases USING btree (kind, btrim(regexp_replace(regexp_replace(regexp_replace(replace(replace(lower(alias_text), 'ё'::text, 'е'::text), '№'::text, ' '::text), '\mпк\s*([0-9]+)'::text, 'пк \1'::text, 'g'::text), '[^0-9a-zа-я]+'::text, ' '::text, 'g'::text), '\s+'::text, ' '::text, 'g'::text)));


--
-- Name: uq_work_type_aliases_norm_code_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_work_type_aliases_norm_code_kind ON public.work_type_aliases USING btree (canonical_code, kind, regexp_replace(replace(lower(btrim(alias_text)), 'ё'::text, 'е'::text), '\s+'::text, ' '::text, 'g'::text));


--
-- Name: ux_pile_plan_periods_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_pile_plan_periods_scope ON public.pile_plan_periods USING btree (COALESCE(section_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(pile_field_id, '00000000-0000-0000-0000-000000000000'::uuid), period_start, period_end, plan_type);


--
-- Name: work_type_unit_rates_unique_base_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX work_type_unit_rates_unique_base_idx ON public.work_type_unit_rates USING btree (work_type_id, region_code) WHERE (pile_length_m IS NULL);


--
-- Name: work_type_unit_rates_unique_length_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX work_type_unit_rates_unique_length_idx ON public.work_type_unit_rates USING btree (work_type_id, region_code, pile_length_m) WHERE (pile_length_m IS NOT NULL);


--
-- Name: mainline_rd_coverage trg_mainline_rd_coverage_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_mainline_rd_coverage_updated_at BEFORE UPDATE ON public.mainline_rd_coverage FOR EACH ROW EXECUTE FUNCTION public.touch_mainline_scheme_context_updated_at();


--
-- Name: mainline_work_schedule_ranges trg_mainline_work_schedule_ranges_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_mainline_work_schedule_ranges_updated_at BEFORE UPDATE ON public.mainline_work_schedule_ranges FOR EACH ROW EXECUTE FUNCTION public.touch_mainline_scheme_context_updated_at();


--
-- Name: pile_fields trg_pile_field_coords; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pile_field_coords BEFORE INSERT OR UPDATE OF pk_start, pk_end ON public.pile_fields FOR EACH ROW EXECUTE FUNCTION public.recalc_segment_coords();


--
-- Name: object_segments trg_segment_coords; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_segment_coords BEFORE INSERT OR UPDATE OF pk_start, pk_end ON public.object_segments FOR EACH ROW EXECUTE FUNCTION public.recalc_segment_coords();


--
-- Name: construction_section_versions trg_service_road_segments_from_settings; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_service_road_segments_from_settings AFTER INSERT OR DELETE OR UPDATE ON public.construction_section_versions FOR EACH STATEMENT EXECUTE FUNCTION public.sync_service_road_segments_from_settings();


--
-- Name: temporary_roads trg_temp_road_object_segment; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_temp_road_object_segment AFTER INSERT OR UPDATE OF object_id, rail_start_pk, rail_end_pk, road_code ON public.temporary_roads FOR EACH ROW EXECUTE FUNCTION public.sync_temp_road_object_segment();


--
-- Name: temporary_road_status_segments trg_temp_road_status_object_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_temp_road_status_object_id BEFORE INSERT OR UPDATE OF road_id ON public.temporary_road_status_segments FOR EACH ROW EXECUTE FUNCTION public.sync_temporary_road_status_object_id();


--
-- Name: construction_section_versions construction_section_versions_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_section_versions
    ADD CONSTRAINT construction_section_versions_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.construction_sections(id) ON DELETE CASCADE;


--
-- Name: constructive_work_types constructive_work_types_constructive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constructive_work_types
    ADD CONSTRAINT constructive_work_types_constructive_id_fkey FOREIGN KEY (constructive_id) REFERENCES public.constructives(id) ON DELETE CASCADE;


--
-- Name: constructive_work_types constructive_work_types_work_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constructive_work_types
    ADD CONSTRAINT constructive_work_types_work_type_id_fkey FOREIGN KEY (work_type_id) REFERENCES public.work_types(id) ON DELETE CASCADE;


--
-- Name: constructives constructives_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constructives
    ADD CONSTRAINT constructives_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: constructives constructives_object_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constructives
    ADD CONSTRAINT constructives_object_type_id_fkey FOREIGN KEY (object_type_id) REFERENCES public.object_types(id);


--
-- Name: daily_report_parse_candidates daily_report_parse_candidates_daily_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_parse_candidates
    ADD CONSTRAINT daily_report_parse_candidates_daily_report_id_fkey FOREIGN KEY (daily_report_id) REFERENCES public.daily_reports(id) ON DELETE CASCADE;


--
-- Name: daily_report_problems daily_report_problems_daily_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_problems
    ADD CONSTRAINT daily_report_problems_daily_report_id_fkey FOREIGN KEY (daily_report_id) REFERENCES public.daily_reports(id) ON DELETE CASCADE;


--
-- Name: daily_report_quality_metrics daily_report_quality_metrics_daily_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_quality_metrics
    ADD CONSTRAINT daily_report_quality_metrics_daily_report_id_fkey FOREIGN KEY (daily_report_id) REFERENCES public.daily_reports(id) ON DELETE SET NULL;


--
-- Name: daily_report_quality_metrics daily_report_quality_metrics_day3_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_quality_metrics
    ADD CONSTRAINT daily_report_quality_metrics_day3_snapshot_id_fkey FOREIGN KEY (day3_snapshot_id) REFERENCES public.daily_report_quality_snapshots(id) ON DELETE SET NULL;


--
-- Name: daily_report_quality_metrics daily_report_quality_metrics_uploaded_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_quality_metrics
    ADD CONSTRAINT daily_report_quality_metrics_uploaded_snapshot_id_fkey FOREIGN KEY (uploaded_snapshot_id) REFERENCES public.daily_report_quality_snapshots(id) ON DELETE SET NULL;


--
-- Name: daily_report_quality_snapshots daily_report_quality_snapshots_daily_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_quality_snapshots
    ADD CONSTRAINT daily_report_quality_snapshots_daily_report_id_fkey FOREIGN KEY (daily_report_id) REFERENCES public.daily_reports(id) ON DELETE SET NULL;


--
-- Name: daily_report_review_payload_versions daily_report_review_payload_versions_daily_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_review_payload_versions
    ADD CONSTRAINT daily_report_review_payload_versions_daily_report_id_fkey FOREIGN KEY (daily_report_id) REFERENCES public.daily_reports(id) ON DELETE SET NULL;


--
-- Name: daily_report_staff_counts daily_report_staff_counts_daily_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_report_staff_counts
    ADD CONSTRAINT daily_report_staff_counts_daily_report_id_fkey FOREIGN KEY (daily_report_id) REFERENCES public.daily_reports(id) ON DELETE CASCADE;


--
-- Name: daily_reports daily_reports_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_reports
    ADD CONSTRAINT daily_reports_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.construction_sections(id);


--
-- Name: daily_work_item_segments daily_work_item_segments_daily_work_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_work_item_segments
    ADD CONSTRAINT daily_work_item_segments_daily_work_item_id_fkey FOREIGN KEY (daily_work_item_id) REFERENCES public.daily_work_items(id) ON DELETE CASCADE;


--
-- Name: daily_work_item_segments daily_work_item_segments_pile_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_work_item_segments
    ADD CONSTRAINT daily_work_item_segments_pile_field_id_fkey FOREIGN KEY (pile_field_id) REFERENCES public.pile_fields(id);


--
-- Name: daily_work_items daily_work_items_constructive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_work_items
    ADD CONSTRAINT daily_work_items_constructive_id_fkey FOREIGN KEY (constructive_id) REFERENCES public.constructives(id);


--
-- Name: daily_work_items daily_work_items_daily_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_work_items
    ADD CONSTRAINT daily_work_items_daily_report_id_fkey FOREIGN KEY (daily_report_id) REFERENCES public.daily_reports(id) ON DELETE CASCADE;


--
-- Name: daily_work_items daily_work_items_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_work_items
    ADD CONSTRAINT daily_work_items_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id);


--
-- Name: daily_work_items daily_work_items_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_work_items
    ADD CONSTRAINT daily_work_items_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.construction_sections(id);


--
-- Name: daily_work_items daily_work_items_work_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_work_items
    ADD CONSTRAINT daily_work_items_work_type_id_fkey FOREIGN KEY (work_type_id) REFERENCES public.work_types(id);


--
-- Name: dashboard_people_rows dashboard_people_rows_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_people_rows
    ADD CONSTRAINT dashboard_people_rows_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.dashboard_people_snapshots(id) ON DELETE CASCADE;


--
-- Name: equipment_operation_metrics equipment_operation_metrics_equipment_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_operation_metrics
    ADD CONSTRAINT equipment_operation_metrics_equipment_unit_id_fkey FOREIGN KEY (equipment_unit_id) REFERENCES public.equipment_units(id) ON DELETE SET NULL;


--
-- Name: equipment_unit_identifiers equipment_unit_identifiers_equipment_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_unit_identifiers
    ADD CONSTRAINT equipment_unit_identifiers_equipment_unit_id_fkey FOREIGN KEY (equipment_unit_id) REFERENCES public.equipment_units(id) ON DELETE CASCADE;


--
-- Name: isso_front_transfer_lines isso_front_transfer_lines_object_attribute_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.isso_front_transfer_lines
    ADD CONSTRAINT isso_front_transfer_lines_object_attribute_id_fkey FOREIGN KEY (object_attribute_id) REFERENCES public.isso_object_front_attributes(id) ON DELETE CASCADE;


--
-- Name: isso_front_transfer_lines isso_front_transfer_lines_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.isso_front_transfer_lines
    ADD CONSTRAINT isso_front_transfer_lines_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: isso_front_transfer_lines isso_front_transfer_lines_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.isso_front_transfer_lines
    ADD CONSTRAINT isso_front_transfer_lines_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.isso_front_transfer_snapshots(id) ON DELETE CASCADE;


--
-- Name: isso_front_transfer_monthly_plan isso_front_transfer_monthly_plan_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.isso_front_transfer_monthly_plan
    ADD CONSTRAINT isso_front_transfer_monthly_plan_line_id_fkey FOREIGN KEY (line_id) REFERENCES public.isso_front_transfer_lines(id) ON DELETE CASCADE;


--
-- Name: isso_object_front_attributes isso_object_front_attributes_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.isso_object_front_attributes
    ADD CONSTRAINT isso_object_front_attributes_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: isso_object_front_attributes isso_object_front_attributes_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.isso_object_front_attributes
    ADD CONSTRAINT isso_object_front_attributes_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.isso_front_transfer_snapshots(id) ON DELETE CASCADE;


--
-- Name: mainline_fill_state_corrections mainline_fill_state_corrections_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mainline_fill_state_corrections
    ADD CONSTRAINT mainline_fill_state_corrections_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.construction_sections(id) ON DELETE RESTRICT;


--
-- Name: mainline_fill_status_segments mainline_fill_status_segments_daily_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mainline_fill_status_segments
    ADD CONSTRAINT mainline_fill_status_segments_daily_report_id_fkey FOREIGN KEY (daily_report_id) REFERENCES public.daily_reports(id) ON DELETE SET NULL;


--
-- Name: mainline_fill_status_segments mainline_fill_status_segments_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mainline_fill_status_segments
    ADD CONSTRAINT mainline_fill_status_segments_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.construction_sections(id) ON DELETE RESTRICT;


--
-- Name: mainline_rd_coverage mainline_rd_coverage_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mainline_rd_coverage
    ADD CONSTRAINT mainline_rd_coverage_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: mainline_rd_coverage mainline_rd_coverage_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mainline_rd_coverage
    ADD CONSTRAINT mainline_rd_coverage_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.construction_sections(id) ON DELETE SET NULL;


--
-- Name: mainline_work_schedule_ranges mainline_work_schedule_ranges_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mainline_work_schedule_ranges
    ADD CONSTRAINT mainline_work_schedule_ranges_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: mainline_work_schedule_ranges mainline_work_schedule_ranges_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mainline_work_schedule_ranges
    ADD CONSTRAINT mainline_work_schedule_ranges_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.construction_sections(id) ON DELETE SET NULL;


--
-- Name: material_movement_equipment_usage material_movement_equipment_usage_material_movement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_movement_equipment_usage
    ADD CONSTRAINT material_movement_equipment_usage_material_movement_id_fkey FOREIGN KEY (material_movement_id) REFERENCES public.material_movements(id) ON DELETE CASCADE;


--
-- Name: material_movement_equipment_usage material_movement_equipment_usage_report_equipment_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_movement_equipment_usage
    ADD CONSTRAINT material_movement_equipment_usage_report_equipment_unit_id_fkey FOREIGN KEY (report_equipment_unit_id) REFERENCES public.report_equipment_units(id) ON DELETE CASCADE;


--
-- Name: material_movements material_movements_contractor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_movements
    ADD CONSTRAINT material_movements_contractor_id_fkey FOREIGN KEY (contractor_id) REFERENCES public.contractors(id);


--
-- Name: material_movements material_movements_daily_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_movements
    ADD CONSTRAINT material_movements_daily_report_id_fkey FOREIGN KEY (daily_report_id) REFERENCES public.daily_reports(id) ON DELETE CASCADE;


--
-- Name: material_movements material_movements_from_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_movements
    ADD CONSTRAINT material_movements_from_object_id_fkey FOREIGN KEY (from_object_id) REFERENCES public.objects(id);


--
-- Name: material_movements material_movements_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_movements
    ADD CONSTRAINT material_movements_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(id);


--
-- Name: material_movements material_movements_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_movements
    ADD CONSTRAINT material_movements_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.construction_sections(id);


--
-- Name: material_movements material_movements_to_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_movements
    ADD CONSTRAINT material_movements_to_object_id_fkey FOREIGN KEY (to_object_id) REFERENCES public.objects(id);


--
-- Name: object_map_points object_map_points_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.object_map_points
    ADD CONSTRAINT object_map_points_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: object_segments object_segments_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.object_segments
    ADD CONSTRAINT object_segments_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: object_type_work_type_defaults object_type_work_type_defaults_object_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.object_type_work_type_defaults
    ADD CONSTRAINT object_type_work_type_defaults_object_type_id_fkey FOREIGN KEY (object_type_id) REFERENCES public.object_types(id);


--
-- Name: object_type_work_type_defaults object_type_work_type_defaults_work_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.object_type_work_type_defaults
    ADD CONSTRAINT object_type_work_type_defaults_work_type_id_fkey FOREIGN KEY (work_type_id) REFERENCES public.work_types(id);


--
-- Name: objects objects_constructive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_constructive_id_fkey FOREIGN KEY (constructive_id) REFERENCES public.constructives(id);


--
-- Name: objects objects_object_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_object_type_id_fkey FOREIGN KEY (object_type_id) REFERENCES public.object_types(id);


--
-- Name: parser_learning_cases parser_learning_cases_daily_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_learning_cases
    ADD CONSTRAINT parser_learning_cases_daily_report_id_fkey FOREIGN KEY (daily_report_id) REFERENCES public.daily_reports(id) ON DELETE CASCADE;


--
-- Name: personnel_accommodation_rows personnel_accommodation_rows_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personnel_accommodation_rows
    ADD CONSTRAINT personnel_accommodation_rows_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.personnel_accommodation_snapshots(id) ON DELETE CASCADE;


--
-- Name: pile_delivery_calendar pile_delivery_calendar_spec_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pile_delivery_calendar
    ADD CONSTRAINT pile_delivery_calendar_spec_code_fkey FOREIGN KEY (spec_code) REFERENCES public.pile_delivery_specs(spec_code) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: pile_fields pile_fields_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pile_fields
    ADD CONSTRAINT pile_fields_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id);


--
-- Name: pile_plan_periods pile_plan_periods_pile_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pile_plan_periods
    ADD CONSTRAINT pile_plan_periods_pile_field_id_fkey FOREIGN KEY (pile_field_id) REFERENCES public.pile_fields(id) ON DELETE CASCADE;


--
-- Name: pile_plan_periods pile_plan_periods_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pile_plan_periods
    ADD CONSTRAINT pile_plan_periods_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.construction_sections(id);


--
-- Name: pipe_pile_specs pipe_pile_specs_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipe_pile_specs
    ADD CONSTRAINT pipe_pile_specs_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: pipe_pile_specs pipe_pile_specs_work_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipe_pile_specs
    ADD CONSTRAINT pipe_pile_specs_work_type_id_fkey FOREIGN KEY (work_type_id) REFERENCES public.work_types(id) ON DELETE RESTRICT;


--
-- Name: planned_work_items planned_work_items_assigned_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_work_items
    ADD CONSTRAINT planned_work_items_assigned_section_id_fkey FOREIGN KEY (assigned_section_id) REFERENCES public.construction_sections(id) ON DELETE SET NULL;


--
-- Name: planned_work_items planned_work_items_constructive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_work_items
    ADD CONSTRAINT planned_work_items_constructive_id_fkey FOREIGN KEY (constructive_id) REFERENCES public.constructives(id) ON DELETE SET NULL;


--
-- Name: planned_work_items planned_work_items_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_work_items
    ADD CONSTRAINT planned_work_items_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: planned_work_items planned_work_items_source_pile_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_work_items
    ADD CONSTRAINT planned_work_items_source_pile_field_id_fkey FOREIGN KEY (source_pile_field_id) REFERENCES public.pile_fields(id) ON DELETE SET NULL;


--
-- Name: planned_work_items planned_work_items_source_pile_plan_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_work_items
    ADD CONSTRAINT planned_work_items_source_pile_plan_period_id_fkey FOREIGN KEY (source_pile_plan_period_id) REFERENCES public.pile_plan_periods(id) ON DELETE SET NULL;


--
-- Name: planned_work_items planned_work_items_source_project_work_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_work_items
    ADD CONSTRAINT planned_work_items_source_project_work_item_id_fkey FOREIGN KEY (source_project_work_item_id) REFERENCES public.project_work_items(id) ON DELETE SET NULL;


--
-- Name: planned_work_items planned_work_items_work_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_work_items
    ADD CONSTRAINT planned_work_items_work_type_id_fkey FOREIGN KEY (work_type_id) REFERENCES public.work_types(id) ON DELETE RESTRICT;


--
-- Name: project_work_item_segments project_work_item_segments_project_work_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_work_item_segments
    ADD CONSTRAINT project_work_item_segments_project_work_item_id_fkey FOREIGN KEY (project_work_item_id) REFERENCES public.project_work_items(id) ON DELETE CASCADE;


--
-- Name: project_work_items project_work_items_constructive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_work_items
    ADD CONSTRAINT project_work_items_constructive_id_fkey FOREIGN KEY (constructive_id) REFERENCES public.constructives(id);


--
-- Name: project_work_items project_work_items_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_work_items
    ADD CONSTRAINT project_work_items_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: project_work_items project_work_items_source_pile_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_work_items
    ADD CONSTRAINT project_work_items_source_pile_field_id_fkey FOREIGN KEY (source_pile_field_id) REFERENCES public.pile_fields(id) ON DELETE SET NULL;


--
-- Name: project_work_items project_work_items_work_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_work_items
    ADD CONSTRAINT project_work_items_work_type_id_fkey FOREIGN KEY (work_type_id) REFERENCES public.work_types(id);


--
-- Name: rd_documents rd_documents_default_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rd_documents
    ADD CONSTRAINT rd_documents_default_object_id_fkey FOREIGN KEY (default_object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: rd_publication_links rd_publication_links_rd_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rd_publication_links
    ADD CONSTRAINT rd_publication_links_rd_document_id_fkey FOREIGN KEY (rd_document_id) REFERENCES public.rd_documents(id) ON DELETE CASCADE;


--
-- Name: rd_publication_links rd_publication_links_rd_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rd_publication_links
    ADD CONSTRAINT rd_publication_links_rd_row_id_fkey FOREIGN KEY (rd_row_id) REFERENCES public.rd_rows(id) ON DELETE SET NULL;


--
-- Name: rd_row_manual_mappings rd_row_manual_mappings_rd_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rd_row_manual_mappings
    ADD CONSTRAINT rd_row_manual_mappings_rd_row_id_fkey FOREIGN KEY (rd_row_id) REFERENCES public.rd_rows(id) ON DELETE CASCADE;


--
-- Name: rd_rows rd_rows_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rd_rows
    ADD CONSTRAINT rd_rows_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(id) ON DELETE SET NULL;


--
-- Name: rd_rows rd_rows_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rd_rows
    ADD CONSTRAINT rd_rows_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: rd_rows rd_rows_rd_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rd_rows
    ADD CONSTRAINT rd_rows_rd_document_id_fkey FOREIGN KEY (rd_document_id) REFERENCES public.rd_documents(id) ON DELETE CASCADE;


--
-- Name: rd_rows rd_rows_work_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rd_rows
    ADD CONSTRAINT rd_rows_work_type_id_fkey FOREIGN KEY (work_type_id) REFERENCES public.work_types(id) ON DELETE SET NULL;


--
-- Name: report_equipment_units report_equipment_units_contractor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_equipment_units
    ADD CONSTRAINT report_equipment_units_contractor_id_fkey FOREIGN KEY (contractor_id) REFERENCES public.contractors(id);


--
-- Name: report_equipment_units report_equipment_units_daily_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_equipment_units
    ADD CONSTRAINT report_equipment_units_daily_report_id_fkey FOREIGN KEY (daily_report_id) REFERENCES public.daily_reports(id) ON DELETE CASCADE;


--
-- Name: report_equipment_units report_equipment_units_equipment_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_equipment_units
    ADD CONSTRAINT report_equipment_units_equipment_unit_id_fkey FOREIGN KEY (equipment_unit_id) REFERENCES public.equipment_units(id);


--
-- Name: section_quarry_haul_distances section_quarry_haul_distances_quarry_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.section_quarry_haul_distances
    ADD CONSTRAINT section_quarry_haul_distances_quarry_object_id_fkey FOREIGN KEY (quarry_object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: section_quarry_haul_distances section_quarry_haul_distances_section_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.section_quarry_haul_distances
    ADD CONSTRAINT section_quarry_haul_distances_section_code_fkey FOREIGN KEY (section_code) REFERENCES public.construction_sections(code) ON DELETE CASCADE;


--
-- Name: statement_customer_closed_work_items statement_customer_closed_work_items_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_customer_closed_work_items
    ADD CONSTRAINT statement_customer_closed_work_items_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: statement_customer_closed_work_items statement_customer_closed_work_items_work_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_customer_closed_work_items
    ADD CONSTRAINT statement_customer_closed_work_items_work_type_id_fkey FOREIGN KEY (work_type_id) REFERENCES public.work_types(id) ON DELETE SET NULL;


--
-- Name: statement_object_unit_rates statement_object_unit_rates_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_object_unit_rates
    ADD CONSTRAINT statement_object_unit_rates_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: statement_object_unit_rates statement_object_unit_rates_work_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_object_unit_rates
    ADD CONSTRAINT statement_object_unit_rates_work_type_id_fkey FOREIGN KEY (work_type_id) REFERENCES public.work_types(id) ON DELETE CASCADE;


--
-- Name: stockpile_balance_snapshots stockpile_balance_snapshots_stockpile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stockpile_balance_snapshots
    ADD CONSTRAINT stockpile_balance_snapshots_stockpile_id_fkey FOREIGN KEY (stockpile_id) REFERENCES public.stockpiles(id) ON DELETE CASCADE;


--
-- Name: stockpiles stockpiles_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stockpiles
    ADD CONSTRAINT stockpiles_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(id);


--
-- Name: stockpiles stockpiles_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stockpiles
    ADD CONSTRAINT stockpiles_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: temp_road_points temp_road_points_road_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temp_road_points
    ADD CONSTRAINT temp_road_points_road_id_fkey FOREIGN KEY (road_id) REFERENCES public.temporary_roads(id) ON DELETE CASCADE;


--
-- Name: temporary_road_pk_mappings temporary_road_pk_mappings_road_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_road_pk_mappings
    ADD CONSTRAINT temporary_road_pk_mappings_road_id_fkey FOREIGN KEY (road_id) REFERENCES public.temporary_roads(id) ON DELETE CASCADE;


--
-- Name: temporary_road_state_corrections temporary_road_state_corrections_road_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_road_state_corrections
    ADD CONSTRAINT temporary_road_state_corrections_road_id_fkey FOREIGN KEY (road_id) REFERENCES public.temporary_roads(id) ON DELETE CASCADE;


--
-- Name: temporary_road_state_corrections temporary_road_state_corrections_source_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_road_state_corrections
    ADD CONSTRAINT temporary_road_state_corrections_source_draft_id_fkey FOREIGN KEY (source_draft_id) REFERENCES public.temporary_road_import_drafts(id) ON DELETE SET NULL;


--
-- Name: temporary_road_status_segments temporary_road_status_segments_daily_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_road_status_segments
    ADD CONSTRAINT temporary_road_status_segments_daily_report_id_fkey FOREIGN KEY (daily_report_id) REFERENCES public.daily_reports(id) ON DELETE CASCADE;


--
-- Name: temporary_road_status_segments temporary_road_status_segments_import_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_road_status_segments
    ADD CONSTRAINT temporary_road_status_segments_import_run_id_fkey FOREIGN KEY (import_run_id) REFERENCES public.temporary_road_import_runs(id) ON DELETE SET NULL;


--
-- Name: temporary_road_status_segments temporary_road_status_segments_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_road_status_segments
    ADD CONSTRAINT temporary_road_status_segments_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: temporary_road_status_segments temporary_road_status_segments_road_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_road_status_segments
    ADD CONSTRAINT temporary_road_status_segments_road_id_fkey FOREIGN KEY (road_id) REFERENCES public.temporary_roads(id) ON DELETE CASCADE;


--
-- Name: temporary_roads temporary_roads_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_roads
    ADD CONSTRAINT temporary_roads_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: temporary_roads temporary_roads_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_roads
    ADD CONSTRAINT temporary_roads_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.construction_sections(id);


--
-- Name: work_item_equipment_usage work_item_equipment_usage_daily_work_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_item_equipment_usage
    ADD CONSTRAINT work_item_equipment_usage_daily_work_item_id_fkey FOREIGN KEY (daily_work_item_id) REFERENCES public.daily_work_items(id) ON DELETE CASCADE;


--
-- Name: work_item_equipment_usage work_item_equipment_usage_report_equipment_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_item_equipment_usage
    ADD CONSTRAINT work_item_equipment_usage_report_equipment_unit_id_fkey FOREIGN KEY (report_equipment_unit_id) REFERENCES public.report_equipment_units(id) ON DELETE CASCADE;


--
-- Name: work_type_unit_rates work_type_unit_rates_work_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_type_unit_rates
    ADD CONSTRAINT work_type_unit_rates_work_type_id_fkey FOREIGN KEY (work_type_id) REFERENCES public.work_types(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict KFKbVwydybEk6uXyGtKK3Lm8cl90wFyiInmMm3c7TRTAu7PkEBQr1dosvuf5Jl5

