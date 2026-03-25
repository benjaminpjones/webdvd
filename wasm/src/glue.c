/*
 * glue.c — Thin C wrapper exposing libdvdnav functions to JavaScript via Emscripten.
 *
 * All exported functions use EMSCRIPTEN_KEEPALIVE and return simple types
 * (int, const char*) so they can be called via cwrap from TypeScript.
 */

#include <emscripten.h>
#include <dvdnav/dvdnav.h>
#include <dvdread/dvd_reader.h>
#include <dvdread/ifo_read.h>
#include <dvdread/ifo_types.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

static dvdnav_t *nav = NULL;

/* --- Lifecycle --- */

EMSCRIPTEN_KEEPALIVE
int dvd_open(const char *path) {
    if (nav) dvdnav_close(nav);
    nav = NULL;
    dvdnav_status_t status = dvdnav_open(&nav, path);
    if (status != DVDNAV_STATUS_OK) {
        nav = NULL;
        return -1;
    }
    /* Disable read-ahead cache — we discard MPEG-2 data anyway */
    dvdnav_set_readahead_flag(nav, 0);
    /* Set region mask to all regions */
    dvdnav_set_region_mask(nav, 0xFF);
    /* Enable PGC-based positioning for accurate time reporting */
    dvdnav_set_PGC_positioning_flag(nav, 1);
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void dvd_close(void) {
    if (nav) { dvdnav_close(nav); nav = NULL; }
}

EMSCRIPTEN_KEEPALIVE
const char* dvd_error(void) {
    if (!nav) return "not open";
    return dvdnav_err_to_string(nav);
}

/* --- Navigation (starts the VM) --- */

EMSCRIPTEN_KEEPALIVE
int dvd_title_play(int title) {
    if (!nav) return -1;
    return dvdnav_title_play(nav, title) == DVDNAV_STATUS_OK ? 0 : -1;
}

/* --- Title/Chapter Info --- */

EMSCRIPTEN_KEEPALIVE
int dvd_get_num_titles(void) {
    int32_t titles = 0;
    if (!nav) return -1;
    if (dvdnav_get_number_of_titles(nav, &titles) != DVDNAV_STATUS_OK)
        return -1;
    return titles;
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_num_parts(int title) {
    int32_t parts = 0;
    if (!nav) return -1;
    if (dvdnav_get_number_of_parts(nav, title, &parts) != DVDNAV_STATUS_OK)
        return -1;
    return parts;
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_num_angles(int title) {
    int32_t angles = 0;
    if (!nav) return -1;
    if (dvdnav_get_number_of_angles(nav, title, &angles) != DVDNAV_STATUS_OK)
        return -1;
    return angles;
}

EMSCRIPTEN_KEEPALIVE
const char* dvd_get_title_string(void) {
    const char *str = NULL;
    if (!nav) return "";
    dvdnav_get_title_string(nav, &str);
    return str ? str : "";
}

EMSCRIPTEN_KEEPALIVE
const char* dvd_get_serial_string(void) {
    const char *str = NULL;
    if (!nav) return "";
    dvdnav_get_serial_string(nav, &str);
    return str ? str : "";
}

/* --- Video Info --- */

EMSCRIPTEN_KEEPALIVE
int dvd_get_video_aspect(void) {
    if (!nav) return -1;
    return dvdnav_get_video_aspect(nav);
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_video_width(void) {
    uint32_t w = 0, h = 0;
    if (!nav) return -1;
    dvdnav_get_video_resolution(nav, &w, &h);
    return (int)w;
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_video_height(void) {
    uint32_t w = 0, h = 0;
    if (!nav) return -1;
    dvdnav_get_video_resolution(nav, &w, &h);
    return (int)h;
}

/* --- Audio Info --- */

EMSCRIPTEN_KEEPALIVE
int dvd_get_num_audio_streams(void) {
    if (!nav) return -1;
    return dvdnav_get_number_of_streams(nav, DVD_AUDIO_STREAM);
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_audio_lang(int stream) {
    if (!nav) return 0;
    return dvdnav_audio_stream_to_lang(nav, (uint8_t)stream);
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_audio_channels(int stream) {
    if (!nav) return 0;
    return dvdnav_audio_stream_channels(nav, (uint8_t)stream);
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_audio_format(int stream) {
    if (!nav) return 0;
    return dvdnav_audio_stream_format(nav, (uint8_t)stream);
}

/* --- Subpicture Info --- */

EMSCRIPTEN_KEEPALIVE
int dvd_get_num_spu_streams(void) {
    if (!nav) return -1;
    return dvdnav_get_number_of_streams(nav, DVD_SUBTITLE_STREAM);
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_spu_lang(int stream) {
    if (!nav) return 0;
    return dvdnav_spu_stream_to_lang(nav, (uint8_t)stream);
}

/* --- VM Navigation (M2) --- */

EMSCRIPTEN_KEEPALIVE
int dvd_still_skip(void) {
    if (!nav) return -1;
    return dvdnav_still_skip(nav) == DVDNAV_STATUS_OK ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int dvd_wait_skip(void) {
    if (!nav) return -1;
    return dvdnav_wait_skip(nav) == DVDNAV_STATUS_OK ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int dvd_part_play(int title, int part) {
    if (!nav) return -1;
    return dvdnav_part_play(nav, title, part) == DVDNAV_STATUS_OK ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_current_title(void) {
    if (!nav) return -1;
    int32_t title = 0, part = 0;
    if (dvdnav_current_title_info(nav, &title, &part) != DVDNAV_STATUS_OK)
        return -1;
    return title;
}

EMSCRIPTEN_KEEPALIVE
int dvd_get_current_part(void) {
    if (!nav) return -1;
    int32_t title = 0, part = 0;
    if (dvdnav_current_title_info(nav, &title, &part) != DVDNAV_STATUS_OK)
        return -1;
    return part;
}

EMSCRIPTEN_KEEPALIVE
int dvd_is_domain_vts(void) {
    if (!nav) return 0;
    return dvdnav_is_domain_vts(nav) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int dvd_is_domain_menu(void) {
    if (!nav) return 0;
    return (dvdnav_is_domain_vmgm(nav) || dvdnav_is_domain_vtsm(nav)) ? 1 : 0;
}

/*
 * dvd_get_next_event() — Core M2 function.
 *
 * Loops dvdnav_get_next_block() internally, skipping BLOCK_OK / NAV_PACKET / NOP
 * (discarding MPEG-2 data). Returns JSON string on the first "interesting" event.
 * Has an iteration cap to avoid infinite WASM hangs.
 *
 * Returned JSON always has "event" (int). Additional fields depend on event type.
 */
static char event_buf[2048];  /* for dvdnav_get_next_block */

static char json_buf[16384];

EMSCRIPTEN_KEEPALIVE
const char* dvd_get_next_event(void) {
    if (!nav) return "{\"event\":-1,\"error\":\"not open\"}";

    int32_t event = 0;
    int32_t len = 0;
    int iterations = 0;
    const int MAX_ITER = 50000;

    while (iterations++ < MAX_ITER) {
        dvdnav_status_t status = dvdnav_get_next_block(nav,
            (uint8_t*)event_buf, &event, &len);

        if (status != DVDNAV_STATUS_OK) {
            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":-1,\"error\":\"%s\"}", dvdnav_err_to_string(nav));
            return json_buf;
        }

        switch (event) {
        case DVDNAV_BLOCK_OK:
        case DVDNAV_NAV_PACKET:
        case DVDNAV_NOP:
            /* Skip — discard MPEG-2 data, continue spinning */
            continue;

        case DVDNAV_CELL_CHANGE: {
            dvdnav_cell_change_event_t *cell =
                (dvdnav_cell_change_event_t*)event_buf;
            int32_t title = 0, part = 0;
            dvdnav_current_title_info(nav, &title, &part);
            int is_vts = dvdnav_is_domain_vts(nav) ? 1 : 0;
            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":6,\"cellN\":%d,\"pgN\":%d,"
                "\"pgcLengthMs\":%lld,\"cellStartMs\":%lld,"
                "\"title\":%d,\"part\":%d,\"isVts\":%d}",
                cell->cellN, cell->pgN,
                (long long)(cell->pgc_length / 90),
                (long long)(cell->cell_start / 90),
                (int)title, (int)part, is_vts);
            return json_buf;
        }

        case DVDNAV_VTS_CHANGE: {
            dvdnav_vts_change_event_t *vts =
                (dvdnav_vts_change_event_t*)event_buf;
            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":5,\"oldVtsN\":%d,\"newVtsN\":%d,"
                "\"oldDomain\":%d,\"newDomain\":%d}",
                vts->old_vtsN, vts->new_vtsN,
                (int)vts->old_domain, (int)vts->new_domain);
            return json_buf;
        }

        case DVDNAV_STILL_FRAME: {
            dvdnav_still_event_t *still =
                (dvdnav_still_event_t*)event_buf;
            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":2,\"stillLength\":%d}", still->length);
            return json_buf;
        }

        case DVDNAV_WAIT:
            /* No internal FIFO to drain — skip immediately and continue */
            dvdnav_wait_skip(nav);
            continue;

        case DVDNAV_STOP:
            return "{\"event\":8}";

        case DVDNAV_HOP_CHANNEL:
            return "{\"event\":12}";

        case DVDNAV_SPU_STREAM_CHANGE: {
            dvdnav_spu_stream_change_event_t *spu =
                (dvdnav_spu_stream_change_event_t*)event_buf;
            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":3,\"physicalWide\":%d,\"physicalLetterbox\":%d,"
                "\"physicalPanScan\":%d,\"logical\":%d}",
                spu->physical_wide, spu->physical_letterbox,
                spu->physical_pan_scan, spu->logical);
            return json_buf;
        }

        case DVDNAV_AUDIO_STREAM_CHANGE: {
            dvdnav_audio_stream_change_event_t *audio =
                (dvdnav_audio_stream_change_event_t*)event_buf;
            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":4,\"physical\":%d,\"logical\":%d}",
                audio->physical, audio->logical);
            return json_buf;
        }

        case DVDNAV_SPU_CLUT_CHANGE:
            /* Colour table update — not needed until M3 */
            continue;

        case DVDNAV_HIGHLIGHT:
            /* Button highlight — not needed until M3 */
            continue;

        default:
            snprintf(json_buf, sizeof(json_buf),
                "{\"event\":%d}", event);
            return json_buf;
        }
    }

    /* Safety valve — yielded after MAX_ITER without an interesting event */
    return "{\"event\":-2,\"error\":\"iteration limit\"}";
}

/* --- Chapter duration info (returns JSON string) --- */

EMSCRIPTEN_KEEPALIVE
const char* dvd_describe_title(int title) {
    if (!nav) return "{}";
    uint64_t *times = NULL;
    uint64_t duration = 0;
    uint32_t n = dvdnav_describe_title_chapters(nav, title, &times, &duration);

    int pos = 0;
    pos += snprintf(json_buf + pos, sizeof(json_buf) - pos,
        "{\"chapters\":%u,\"duration_ms\":%llu,\"chapter_times_ms\":[",
        (unsigned)n, (unsigned long long)(duration / 90));

    for (uint32_t i = 0; i < n && pos < (int)sizeof(json_buf) - 32; i++) {
        if (i > 0) json_buf[pos++] = ',';
        pos += snprintf(json_buf + pos, sizeof(json_buf) - pos,
            "%llu", (unsigned long long)(times[i] / 90));
    }
    pos += snprintf(json_buf + pos, sizeof(json_buf) - pos, "]}");

    if (times) free(times);
    return json_buf;
}
